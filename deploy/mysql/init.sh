#!/bin/bash
# Runs once when the MySQL container initializes an empty data directory.
# wf_writer loads analyses; wf_reader (used by the coach's SQL tool) can only
# SELECT, so read-only access is enforced by MySQL itself. Each analysis lives
# in its own schema named wf_<hash>, which both grants cover by wildcard.
set -euo pipefail
mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" <<SQL
CREATE USER IF NOT EXISTS 'wf_writer'@'%' IDENTIFIED BY '${WF_WRITER_PASSWORD}';
GRANT ALL PRIVILEGES ON \`wf\_%\`.* TO 'wf_writer'@'%';
CREATE USER IF NOT EXISTS 'wf_reader'@'%' IDENTIFIED BY '${WF_READER_PASSWORD}';
GRANT SELECT ON \`wf\_%\`.* TO 'wf_reader'@'%';
FLUSH PRIVILEGES;
SQL
