#!/bin/bash
# Runs once when the MySQL container initializes an empty data directory.
# chesscheck_writer loads analyses; chesscheck_reader (used by the coach's SQL tool) can only
# SELECT, so read-only access is enforced by MySQL itself. Each analysis lives
# in its own schema named chesscheck_<hash>, which both grants cover by wildcard.
set -euo pipefail
mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" <<SQL
CREATE USER IF NOT EXISTS 'chesscheck_writer'@'%' IDENTIFIED BY '${CHESS_CHECK_WRITER_PASSWORD}';
GRANT ALL PRIVILEGES ON \`chesscheck\_%\`.* TO 'chesscheck_writer'@'%';
CREATE USER IF NOT EXISTS 'chesscheck_reader'@'%' IDENTIFIED BY '${CHESS_CHECK_READER_PASSWORD}';
GRANT SELECT ON \`chesscheck\_%\`.* TO 'chesscheck_reader'@'%';
FLUSH PRIVILEGES;
SQL
