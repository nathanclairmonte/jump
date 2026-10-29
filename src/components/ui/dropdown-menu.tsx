import { Check, ChevronRight } from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

function DropdownMenu(
	props: React.ComponentProps<typeof DropdownMenuPrimitive.Root>,
) {
	return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger(
	props: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>,
) {
	return (
		<DropdownMenuPrimitive.Trigger
			data-slot="dropdown-menu-trigger"
			{...props}
		/>
	);
}

function DropdownMenuGroup(
	props: React.ComponentProps<typeof DropdownMenuPrimitive.Group>,
) {
	return (
		<DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
	);
}

// the shared floating-menu surface: matches the launcher action menu (elevated bg, hairline
// ring, soft shadow) so the two menus read as one system.
const MENU_SURFACE =
	"z-50 min-w-[12rem] overflow-hidden rounded-[13px] border border-white/11 bg-elevated p-1.5 text-ink shadow-[0_24px_60px_-14px_rgba(0,0,0,0.8),inset_0_1px_0_rgba(255,255,255,0.05)] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95";

function DropdownMenuContent({
	className,
	sideOffset = 4,
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
	return (
		<DropdownMenuPrimitive.Portal>
			<DropdownMenuPrimitive.Content
				data-slot="dropdown-menu-content"
				sideOffset={sideOffset}
				className={cn(MENU_SURFACE, className)}
				{...props}
			/>
		</DropdownMenuPrimitive.Portal>
	);
}

// item: neutral highlight on focus/hover, clay-red when destructive.
const MENU_ITEM =
	"relative flex cursor-default select-none items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-[13px] text-[#d8d6d1] outline-hidden transition-colors focus:bg-white/7 focus:text-ink data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0";

function DropdownMenuItem({
	className,
	variant = "default",
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
	variant?: "default" | "danger";
}) {
	return (
		<DropdownMenuPrimitive.Item
			data-slot="dropdown-menu-item"
			data-variant={variant}
			className={cn(
				MENU_ITEM,
				variant === "danger" &&
					"text-danger-text focus:bg-danger/12 focus:text-danger-text",
				className,
			)}
			{...props}
		/>
	);
}

function DropdownMenuSub(
	props: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>,
) {
	return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
	className,
	children,
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger>) {
	return (
		<DropdownMenuPrimitive.SubTrigger
			data-slot="dropdown-menu-sub-trigger"
			className={cn(MENU_ITEM, "data-[state=open]:bg-white/7", className)}
			{...props}
		>
			<span className="flex min-w-0 items-center gap-2 truncate">
				{children}
			</span>
			<ChevronRight size={14} className="text-ink-faint" />
		</DropdownMenuPrimitive.SubTrigger>
	);
}

function DropdownMenuSubContent({
	className,
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
	return (
		<DropdownMenuPrimitive.Portal>
			<DropdownMenuPrimitive.SubContent
				data-slot="dropdown-menu-sub-content"
				className={cn(MENU_SURFACE, className)}
				{...props}
			/>
		</DropdownMenuPrimitive.Portal>
	);
}

function DropdownMenuSeparator({
	className,
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
	return (
		<DropdownMenuPrimitive.Separator
			data-slot="dropdown-menu-separator"
			className={cn("mx-2 my-[5px] h-px bg-white/7", className)}
			{...props}
		/>
	);
}

function DropdownMenuLabel({
	className,
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
	return (
		<DropdownMenuPrimitive.Label
			data-slot="dropdown-menu-label"
			className={cn(
				"px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint",
				className,
			)}
			{...props}
		/>
	);
}

// a trailing check used to mark the applied choice in a submenu (color / editor override).
function DropdownMenuCheck({ shown }: { shown: boolean }) {
	return shown ? (
		<Check size={13} strokeWidth={2.5} className="text-accent-soft" />
	) : null;
}

export {
	DropdownMenu,
	DropdownMenuCheck,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
};
