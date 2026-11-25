import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { connect } from "node:net";
import { join } from "node:path";

const load = name => JSON.parse(readFileSync(new URL('../fixtures/' + name + '.json', import.meta.url)));
const callback = load("callback_187138001290");
const archived = load("archive_187138001290");
const lichess = load("lichess_parity").exports.W7osCRYM;

export const chessId = String(callback.game.id);
export const lichessId = lichess.id;
export const chessOrigin = "https://www.chess.com";
export const chessGame = chessOrigin + "/game/live/" + chessId;
export const lichessGame = "https://lichess.org/game/" + lichessId;
const chessUser = callback.game.pgnHeaders.White;
const lichessUser = lichess.players.white.user.id;
const archivePath = "/pub/player/" + chessUser.toLowerCase() + "/games";
const month = archivePath + "/2026/11";
const hosts = new Set(["www.chess.com", "chess.com", "api.chess.com", "lichess.org"]);
const loopback = "127.0.0.1";

function listen(server) {
  return new Promise(resolve => server.listen(0, loopback, () => resolve(server.address().port)));
}

const page = body => "<!doctype html><meta charset=utf-8>" + body;
const chessPage = page('<a class="sidebar-link" href="/member/' + chessUser + '">' + chessUser + '</a>');
// A finished Lichess board consumes the move fragment when it starts up.
const lichessPage = page('<script>if (/^#[0-9]+$/.test(location.hash)) {' +
  'document.documentElement.dataset.boardPly = location.hash.slice(1);' +
  'history.replaceState(null, "", location.pathname);}</script>' +
  '<button id="user_tag">' + lichessUser + '</button>');

export async function serveFixtures(dir) {
  const key = join(dir, "key.pem"), cert = join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=Chess Check fixture", "-keyout", key, "-out", cert], { stdio: "ignore" });
  const fixture = { requests: [], unexpected: [], chessFinished: true, lichessStatus: lichess.status };
  const send = (res, type, body) => res.writeHead(200, {
    "Content-Type": type, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*",
  }).end(body);
  const json = (res, body) => send(res, "application/json", JSON.stringify(body));
  const server = httpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, res) => {
    const host = req.headers.host;
    const url = new URL(req.url, "https://fixture.invalid");
    const { pathname } = url;
    fixture.requests.push({ host, path: pathname, query: Object.fromEntries(url.searchParams) });
    if (hosts.has(host) && pathname === "/favicon.ico") return res.writeHead(204).end();
    if (host === "www.chess.com" || host === "chess.com") {
      if (pathname === "/game/live/" + chessId) return send(res, "text/html", chessPage);
      if (pathname === "/play" || pathname === "/live") return send(res, "text/html", page("<title>Play fixture</title>"));
      if (pathname === "/callback/live/game/" + chessId) {
        await fixture.holdCallback;
        return json(res, { game: { ...callback.game, isFinished: fixture.chessFinished } });
      }
    }
    if (host === "api.chess.com") {
      if (pathname === archivePath + "/archives") return json(res, { archives: ["https://api.chess.com" + month] });
      if (pathname === month) return json(res, { games: [archived] });
      if (pathname === "/pub/player/" + callback.game.pgnHeaders.Black.toLowerCase() + "/games/archives") {
        return json(res, { archives: [] });
      }
    }
    if (host === "lichess.org") {
      if (pathname === "/game/" + lichessId) return send(res, "text/html", lichessPage);
      if (pathname === "/game/export/" + lichessId) {
        const { moves, clocks, ...status } = lichess;
        if (url.searchParams.get("moves") === "true") {
          return json(res, { ...status, moves, clocks, status: fixture.lichessStatus });
        }
        return json(res, { ...status, status: fixture.lichessStatus });
      }
      // There is no opponent opening history in this fixture. A fresh player profile can use this game.
      if (pathname.startsWith("/api/games/user/")) {
        return send(res, "application/x-ndjson",
          pathname.endsWith("/" + lichessUser) ? JSON.stringify(lichess) + "\n" : "");
      }
    }
    fixture.unexpected.push(host + req.url);
    res.writeHead(404).end();
  });
  const port = await listen(server);

  // Every Chrome HTTP(S) target, including the extension worker and offscreen document, uses
  // this proxy. CONNECT only opens sockets to the loopback fixture server, never to its target.
  const proxy = httpServer((req, res) => {
    fixture.unexpected.push(req.url);
    res.writeHead(403).end();
  });
  const sockets = new Set();
  proxy.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  proxy.on("connect", (req, client, head) => {
    const host = req.url.replace(/:443$/, "");
    if (req.url !== host + ":443" || !hosts.has(host)) {
      fixture.unexpected.push(req.url);
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect(port, loopback, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });

  fixture.proxy = loopback + ":" + await listen(proxy);
  fixture.close = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([proxy, server].map(s => new Promise(resolve => s.close(resolve))));
  };
  return fixture;
}
