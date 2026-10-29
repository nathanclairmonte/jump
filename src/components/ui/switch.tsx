"use client";

import { Switch as SwitchPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

function Switch({
	className,
	...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
	return (
		<SwitchPrimitive.Root
			data-slot="switch"
			className={cn(
				"relative inline-flex h-[22px] w-[38px] flex-none rounded-full outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-accent-orange data-[state=unchecked]:bg-white/[0.12]",
				className,
			)}
			{...props}
		>
			<SwitchPrimitive.Thumb
				data-slot="switch-thumb"
				className={cn(
					"pointer-events-none absolute top-[2.5px] block size-[17px] rounded-full transition-all data-[state=checked]:left-[18.5px] data-[state=checked]:bg-on-accent data-[state=unchecked]:left-[2.5px] data-[state=unchecked]:bg-ink-secondary",
				)}
			/>
		</SwitchPrimitive.Root>
	);
}

export { Switch };
