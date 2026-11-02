import "react";

declare module "react" {
	interface CSSProperties {
		"--fill"?: number;
		"--tile"?: string;
	}
}
