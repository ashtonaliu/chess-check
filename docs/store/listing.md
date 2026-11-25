# Chrome Web Store submission

## Listing fields

**Name**

Chess Check: post-game recaps

**Category and language**

Education, English

**Description**

Chess Check gives you a short recap after every game you finish on Chess.com or Lichess, right on the site.

When a game ends, the Chess Check cube in the corner turns green. Open it to see:
• The result, and how likely it was from both players' ratings
• The turning point: the move that cost you the most, asked as a question. Find the better move on the site's own board, or reveal it.
• Your opening, and how it has gone for you in your recent games
• What your opponent usually plays in that opening
• Patterns from your recent games, such as the tactics you miss most

Missed moves go into a review queue that brings each position back after 1, 3, 7 and 21 days until you find it. Review cards also say how often players at your rating find the move, where that estimate has been checked against real games.

Fair play first. Chess.com and Lichess forbid outside help during a game. Chess Check shows and computes nothing about a game until the site confirms it is over, and it pauses all analysis while any tab is on a play page or an unfinished game.

Fast and private. Stockfish runs in your browser. With your history saved, a recap is ready in about 1 to 5 seconds. Your analysis and review progress stay in your Chrome profile, and nothing is sent to me or to any analytics service.

No account and no setup. Chess Check reads your signed-in username from the page, or asks once which player you are.

Chess Check is open source: https://github.com/ashtonaliu/chess-check

**Website**

https://ashtonaliu.github.io/chess-check/

**Support**

https://github.com/ashtonaliu/chess-check/issues

**Privacy policy**

https://ashtonaliu.github.io/chess-check/privacy.html

## What's new in 0.9.1

Chess.com review cards now also show find-rate estimates for rapid (1800 to 2099) and bullet
(1700 to 2099), where the shipped model passed held-out calibration checks. Other Chess.com
rapid and bullet ratings stay hidden. The model has no Chess.com rapid or bullet training games,
and its estimates there were off by up to 13 points on rapid and 15 on bullet.

## What's new in 0.9.0

Chess Check now recaps finished Lichess games. On Chess.com, finished Chess960 and odds games
show a clear message and the classic `/live` page pauses analysis. The WebAssembly replay rejects
empty move entries. These three fixes ship for the first time in 0.9.0.
[#112](https://github.com/ashtonaliu/chess-check/pull/112) · [#110](https://github.com/ashtonaliu/chess-check/pull/110) · [#114](https://github.com/ashtonaliu/chess-check/pull/114)

Review cards show how often players at your rating find the move only where I checked the
estimate against held-out games. On Lichess that now covers UltraBullet, bullet, blitz, rapid and
classical, each with its own rating range. On Chess.com it covers blitz from 1200 to 1899. The
estimate ran about 3 points too high from 1900 to 2000, so those cards no longer show it.
[#130](https://github.com/ashtonaliu/chess-check/pull/130)

## What's new in 0.8.0

Review cards now use a neural find-rate model to estimate how often players at your rating find the best move. Analysis uses a Rust chess core compiled to WebAssembly.

## Privacy practices fields

**Single purpose**

Help Chess.com and Lichess players learn from finished games with on-device Stockfish recaps and spaced review of missed moves.

**Permissions**

- `storage` remembers the selected player, panel position, and review progress in this Chrome profile.
- `unlimitedStorage` keeps the IndexedDB analysis cache and saved profiles for many games. Reusing those searches avoids repeatedly running Stockfish across the same history.
- `offscreen` runs bundled workers for Stockfish and tactics analysis outside the game page's rendering thread.
- Chess.com content script access is limited to `www.chess.com` and `chess.com`. The script reads the game ID and player identity, checks the game’s status and moves with Chess.com, and mounts the recap panel on the page.
- `https://api.chess.com/*` allows the offscreen document to retrieve historical games via the public archive API.
- `https://www.chess.com/*` and `https://chess.com/*` host access (added in 0.7.1) lets the service worker read the addresses of open Chess.com tabs. While any tab is on the Play page or on a game not yet confirmed finished, it pauses analysis in every tab. The service worker uses the address to apply the pause.

- `https://lichess.org/*` gives the content script access to the page address and signed-in username and lets it mount the panel. The service worker uses the public game ID to check status, fetches details after the game ends, and reads finished game history. It pauses analysis across tabs when a Lichess game is unconfirmed or a play page is open.

**Remote code**

The extension runs packaged JavaScript and WebAssembly. Network requests to Chess.com and Lichess return game data. The unpacked-install reload bridge is gated to development installs in the service worker.

**Data handling**

Disclose Chess.com and Lichess usernames, supported site tab addresses, public game URLs and IDs, game records, board and move data, ratings, review activity, preferences, and frame timings for local performance tuning. Chrome sends existing Chess.com cookies when requesting a game from the Chess.com game endpoint. Lichess API requests omit cookies and use public game IDs. The extension uses this data for its single purpose, keeps analysis and review progress locally, and sends no game or analysis data to the developer or analytics providers. Match the dashboard’s data categories and declarations to the policy and the version being uploaded.

## Assets

- Upload the ZIP from `bash scripts/build_extension.sh`. Its manifest is at the archive root.
- Use [the 128 × 128 icon](../../extension/icons/128.png) and three 1280 × 800 screenshots, in this order:
  1. [A Lichess recap beside the turning point](lichess-recap-1280x800.png). The board shows the position before the move that cost the most.
  2. [A Chess.com recap after a finished game](recap-1280x800.png).
  3. [A review card on the Chess.com board](review-card-1280x800.png), asking for the better move in an earlier game.
- Confirm the public privacy URL is accessible after the GitHub Pages deployment before submitting. Review the listing and privacy fields in the Developer Dashboard. [Chrome listing requirements](https://developer.chrome.com/docs/webstore/cws-dashboard-listing) · [Chrome privacy guidance](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)

## Reviewer instructions

1. Open [this finished Chess.com game](https://www.chess.com/game/live/187138001290).
2. Click the Chess Check cube in the lower-right corner. If prompted, choose the White player, ashton-iwnl.
3. Wait for the turning point. Select **Find it on the board** to open the move with the recap beside it, or select **Reveal the move** to see the answer.
4. To verify the game-in-progress guard, open the Chess.com Play page. The extension provides no review positions there.
5. For Lichess, open [this finished Lichess game](https://lichess.org/game/BYvvanic) and click the cube. Lichess may show a short security check first. Choose either player, since this is not your game, and the recap appears the same way.
