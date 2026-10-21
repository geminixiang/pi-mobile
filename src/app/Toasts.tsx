// Short notices above the composer (Base UI Toast): the newest in front, a few stacked, each gone after a few seconds,
// on a tap, or with a swipe to the side. showToast() works from anywhere, including outside React.
import { Toast } from "@base-ui/react/toast";
import type { ReactNode } from "react";

const manager = Toast.createToastManager();

export function showToast(message: string): void {
	manager.add({ description: message });
}

function List() {
	const { toasts } = Toast.useToastManager();
	return toasts.map((toast) => (
		// Tapping closes it too. Not a close button around it: Base UI starts no swipe on a button.
		<Toast.Root key={toast.id} toast={toast} className="toast" swipeDirection={["left", "right"]} onClick={() => manager.close(toast.id)}>
			<Toast.Description className="toast-text" />
		</Toast.Root>
	));
}

export function Toasts({ children }: { children: ReactNode }) {
	return (
		<Toast.Provider toastManager={manager} timeout={3500} limit={3}>
			{children}
			<Toast.Portal>
				<Toast.Viewport className="toasts">
					<List />
				</Toast.Viewport>
			</Toast.Portal>
		</Toast.Provider>
	);
}
