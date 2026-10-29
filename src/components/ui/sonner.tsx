import { Toaster as Sonner, type ToasterProps } from "sonner";

// the app is dark-only, so the toaster is hard-themed dark and mapped onto jump's tokens
// (elevated surface, hairline ring, ink text) rather than sonner's default light palette.
function Toaster(props: ToasterProps) {
	return (
		<Sonner
			theme="dark"
			className="toaster group"
			style={
				{
					"--normal-bg": "var(--color-elevated)",
					"--normal-text": "var(--color-ink-body)",
					"--normal-border": "var(--color-hairline)",
					"--border-radius": "12px",
				} as React.CSSProperties
			}
			{...props}
		/>
	);
}

export { Toaster };
