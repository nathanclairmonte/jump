import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merges class names, resolving tailwind conflicts (last wins). The standard
 * shadcn helper; kept here so components added later resolve `@/lib/utils`.
 */
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
