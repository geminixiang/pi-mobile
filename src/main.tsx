import "./shims/buffer-global.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { capacitorUi } from "./app/capacitor.ts";
import { Crash } from "./app/Crash.tsx";
import "./app/fonts.ts";
import "./app/index.css";
import { watchMainThread } from "pi-mobile-base/log";
import { keepLogOnDevice } from "./app/diagnostics.ts";
import { showPresses } from "./app/press.ts";
import { boot } from "./app/session.ts";
import { ios } from "./native.ts";
import { installPlatform } from "./ui/platform.ts";

installPlatform(capacitorUi);
watchMainThread();
keepLogOnDevice();
showPresses(document);
boot();
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
