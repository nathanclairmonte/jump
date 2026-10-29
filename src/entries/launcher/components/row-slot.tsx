import { Fragment, type ReactNode } from "react";

interface RowSlotProps {
	id: string;
	// optional slot rendered right after the row (the inline launch-error card).
	renderAfter?: (id: string) => ReactNode;
	children: ReactNode;
}

// hosts a row plus its optional trailing slot, shared by every launcher list so the slot is
// rendered identically everywhere and a new list can't silently omit it. the slot sits
// outside the row node, so in the sortable list it never registers as a drag target.
export function RowSlot({ id, renderAfter, children }: RowSlotProps) {
	return (
		<Fragment>
			{children}
			{renderAfter?.(id)}
		</Fragment>
	);
}
