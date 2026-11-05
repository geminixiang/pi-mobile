import "./shims/buffer-global.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { Crash } from "./app/Crash.tsx";
import "./app/fonts.ts";
import "./app/index.css";
import { watchMainThread } from "./log.ts";
import { keepLogOnDevice } from "./app/diagnostics.ts";
import { ios } from "./native.ts";

watchMainThread();
keepLogOnDevice();
if (ios) document.documentElement.dataset.platform = "ios";
const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(
	<StrictMode>
		<Crash>
			<App />
		</Crash>
	</StrictMode>,
);
