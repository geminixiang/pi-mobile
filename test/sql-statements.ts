import assert from "node:assert/strict";
import { severalStatements } from "../src/agent/tools/database.ts";

for (const one of ["SELECT 1", "SELECT 1;", "  SELECT 1 ;  ;\n", "INSERT INTO t VALUES ('a;b')", "SELECT 1 -- a; b", "SELECT 1 /* a; b */;", 'SELECT ";" FROM t', "CREATE TRIGGER t AFTER INSERT ON a BEGIN DELETE FROM b; DELETE FROM c; END;", "create temp trigger t after insert on a begin select 1; end"]) {
	assert.equal(severalStatements(one), false, one);
}
for (const several of ["INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);", "SELECT 1; SELECT 2", "SELECT 1;\n-- done\nSELECT 2"]) {
	assert.equal(severalStatements(several), true, several);
}
console.log("sql: one statement per entry, a trigger's body and text inside strings or comments do not count");
