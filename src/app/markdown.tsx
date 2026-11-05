import { type ComponentProps, isValidElement, lazy, Suspense, useContext, useState } from "react";
import remarkBreaks from "remark-breaks";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./CopyButton.tsx";
import { OpenFileContext } from "./openFile.ts";
import { isSource } from "./sources.ts";

const Mermaid = lazy(() => import("./Mermaid.tsx"));

function CodeBlock({ children, diagrams }: ComponentProps<"pre"> & { diagrams?: boolean }) {
	const [showSource, setShowSource] = useState(false);
	const code = isValidElement<{ className?: string; children?: unknown }>(children) ? children.props : undefined;
	const language = /language-(\S+)/.exec(code?.className ?? "")?.[1] ?? "";
	const source = String(code?.children ?? "").replace(/\n$/, "");
	const pre = <pre>{children}</pre>;
	const diagram = diagrams && language === "mermaid";
	return (
		<div className="code">
			<div className="code-head">
				<span>{language || "text"}</span>
				{diagram ? (
					<button type="button" className="code-toggle" onClick={() => setShowSource(!showSource)}>
						{showSource ? "圖表" : "原始碼"}
					</button>
				) : null}
				<CopyButton text={source} className="code-copy" />
			</div>
			{diagram && !showSource ? (
				<Suspense fallback={<div className="diagram-loading" />}>
					<Mermaid source={source} fallback={pre} />
				</Suspense>
			) : (
				pre
			)}
		</div>
	);
}

function Table(props: ComponentProps<"table">) {
	return (
		<div className="table">
			<table {...props} />
		</div>
	);
}

const ENCODED = /%[0-9a-f]{2}/i;

function Link({ href, children, ...props }: ComponentProps<"a">) {
	const openFile = useContext(OpenFileContext);
	return (
		<a
			{...props}
			className={href && typeof children === "string" && isSource(href, children) ? "source" : undefined}
			href={href}
			onClick={(event) => {
				if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
				event.preventDefault();
				openFile?.(ENCODED.test(href) ? decodeURIComponent(href) : href);
			}}
		>
			{children}
		</a>
	);
}

export const markdownComponents = { pre: (props: ComponentProps<"pre">) => <CodeBlock {...props} diagrams />, table: Table, a: Link };
export const streamingMarkdownComponents = { pre: CodeBlock, table: Table, a: Link };
export const remarkPlugins = [remarkGfm, remarkCjkFriendly, remarkBreaks];
