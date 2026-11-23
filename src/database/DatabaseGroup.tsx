import { useState } from "react";
import { native } from "../native.ts";
import { messageOf } from "pi-mobile-base/promise";
import { useLoaded } from "../ui/loaded.ts";
import { RowList } from "../ui/RowList.tsx";
import { Database } from "./plugin.ts";

export function DatabaseGroup() {
	const tables = useLoaded(native.has("Database") ? () => Database.schema().then((schema) => schema.tables) : undefined, []).value;
	const [exportError, setExportError] = useState<string>();
	if (!tables) return null;
	return (
		<RowList title="資料表">
			{tables.length === 0 ? (
				<p className="row-empty">還沒有資料表</p>
			) : (
				tables.map((table) => (
					<div className="row-static" key={table.name}>
						<code className="menu-text">{table.name}</code>
						<span className="row-count">{table.rows} 筆</span>
					</div>
				))
			)}
			<div className="inline-verbs">
				<button
					type="button"
					onClick={() => {
						setExportError(undefined);
						void Database.export().catch((error: unknown) => setExportError(`匯出失敗：${messageOf(error)}`));
					}}
				>
					匯出
				</button>
			</div>
			{exportError ? <p className="row-empty error">{exportError}</p> : null}
		</RowList>
	);
}
