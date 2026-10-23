import { strFromU8, unzipSync } from "fflate";

const children = (element: Element, name: string) => [...element.children].filter((child) => child.localName === name);

function paragraphText(paragraph: Element): string {
	let text = "";
	const walk = (node: Element) => {
		for (const child of node.children) {
			switch (child.localName) {
				case "t":
					text += child.textContent ?? "";
					break;
				case "tab":
					text += "\t";
					break;
				case "br":
				case "cr":
					text += "\n";
					break;
				case "del":
				case "instrText":
					break;
				default:
					walk(child);
			}
		}
	};
	walk(paragraph);
	return text;
}

function paragraph(element: Element): string {
	const text = paragraphText(element).trim();
	if (!text) return "";
	const properties = children(element, "pPr")[0];
	const style = properties ? children(properties, "pStyle")[0]?.getAttribute("w:val") ?? "" : "";
	const level = /^Heading([1-6])$/i.exec(style)?.[1] ?? (/^Title$/i.test(style) ? "1" : undefined);
	if (level) return `${"#".repeat(Number(level))} ${text}`;
	if (properties && children(properties, "numPr").length > 0) return `- ${text}`;
	return text;
}

function table(element: Element): string {
	const rows = children(element, "tr").map((row) =>
		children(row, "tc").map((cell) =>
			children(cell, "p")
				.map((p) => paragraphText(p).trim())
				.filter(Boolean)
				.join(" ")
				.replace(/\|/g, "\\|"),
		),
	);
	if (rows.length === 0) return "";
	const width = Math.max(...rows.map((row) => row.length));
	const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
	return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
}

export async function extractDocx(file: Blob): Promise<string> {
	const files = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (entry) => entry.name === "word/document.xml" });
	const xml = files["word/document.xml"];
	if (!xml) throw new Error("not a Word document (no word/document.xml)");
	const doc = new DOMParser().parseFromString(strFromU8(xml), "application/xml");
	const body = [...doc.documentElement.children].find((child) => child.localName === "body");
	if (!body) return "";
	const blocks: string[] = [];
	for (const child of body.children) {
		if (child.localName === "p") blocks.push(paragraph(child));
		else if (child.localName === "tbl") blocks.push(table(child));
	}
	return blocks.filter(Boolean).join("\n\n");
}
