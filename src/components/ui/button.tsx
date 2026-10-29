import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
	"inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				// the orange CTA spark, reserved for confirming actions
				default:
					"bg-primary font-semibold text-primary-foreground hover:bg-accent-orange-hover",
				// neutral bordered pill: the default for utility actions
				outline: "border border-white/10 text-ink-body hover:bg-row-hover",
				// borderless hover-only, e.g. the row's remove icon
				ghost: "text-ink-body hover:bg-row-hover",
			},
			size: {
				default: "gap-1.5 rounded-button px-3.5 py-[7px] text-[13px]",
				sm: "gap-1 rounded-button-sm px-[11px] py-1.5 text-[12px]",
				icon: "h-[30px] w-[30px] rounded-button-sm",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

function Button({
	className,
	variant = "default",
	size = "default",
	asChild = false,
	...props
}: React.ComponentProps<"button"> &
	VariantProps<typeof buttonVariants> & {
		asChild?: boolean;
	}) {
	const Comp = asChild ? Slot.Root : "button";

	return (
		<Comp
			data-slot="button"
			data-variant={variant}
			data-size={size}
			className={cn(buttonVariants({ variant, size, className }))}
			{...props}
		/>
	);
}

export { Button, buttonVariants };
