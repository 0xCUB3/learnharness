"use client";

import { Fragment, useMemo } from "react";
import { useSessionMermaid } from "@/components/session-overlay";

/**
 * THE SHARED RASTER DISPLAY: one gallery for the learner's own pictures
 * (UserMessageParts) and for native image blocks a tool returned (read,
 * pdf_view). Only raster data: URLs of a known MIME are ever rendered, so
 * no SVG, no remote URL and no other active content can reach an <img>.
 * A click opens the shared ImageLightbox.
 */

/** The raster formats the whole image path accepts (src/core/images.ts). */
export const RASTER_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]{16,})/;
const BASE64_HEAD = /^[A-Za-z0-9+/]{16,}/;

/** Is this a raster data URL? Checks the header and the first base64 chars
 *  only: a multi-megabyte payload is never scanned on a render. */
export function isRasterDataUrl(url: unknown): url is string {
	if (typeof url !== "string" || url.length > 40_000_000) return false;
	return DATA_URL.test(url.slice(0, 160));
}

/** The MIME type of a raster data URL, or null. */
export function rasterMimeOf(url: string): string | null {
	return DATA_URL.exec(url.slice(0, 160))?.[1] ?? null;
}

export interface GalleryItem {
	/** A raster data: URL (anything else is dropped). */
	url: string;
	alt?: string;
	caption?: string;
}

/** Native image blocks to gallery items; blocks with an unknown MIME or a
 *  malformed payload are skipped. Never throws on foreign shapes. */
export function galleryItemsFromBlocks(blocks: unknown, caption?: string): GalleryItem[] {
	if (!Array.isArray(blocks)) return [];
	const items: GalleryItem[] = [];
	for (const b of blocks) {
		const v = (b ?? {}) as Record<string, unknown>;
		if (v.type !== "image" || typeof v.mimeType !== "string" || typeof v.data !== "string") continue;
		if (!(RASTER_MIMES as readonly string[]).includes(v.mimeType)) continue;
		if (!BASE64_HEAD.test(v.data.slice(0, 64))) continue;
		items.push({ url: `data:${v.mimeType};base64,${v.data}`, caption });
	}
	return items;
}

function Thumb({ item, onOpen }: { item: GalleryItem; onOpen?: (url: string) => void }) {
	const alt = item.alt ?? item.caption ?? "Image";
	if (!onOpen) {
		// No shared lightbox here: thumbnail plus a download link only (no
		// overlay is mounted inside a scroller).
		const ext = rasterMimeOf(item.url) === "image/jpeg" ? "jpg" : (rasterMimeOf(item.url) ?? "image/png").slice(6);
		return (
			<span className="my-1 inline-flex w-fit max-w-full flex-col items-start gap-0.5">
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img src={item.url} alt={alt} data-testid="user-image" className="max-h-64 w-auto max-w-full rounded-[6px] border" />
				<a href={item.url} download={`image.${ext}`} className="text-xs text-muted-foreground underline">
					Download
				</a>
			</span>
		);
	}
	return (
		<button
			type="button"
			data-testid="user-image"
			onClick={() => onOpen(item.url)}
			aria-label="View image in full"
			title={item.caption}
			className="my-1 block w-fit max-w-full cursor-zoom-in"
		>
			{/* eslint-disable-next-line @next/next/no-img-element */}
			<img src={item.url} alt={alt} className="max-h-64 w-auto max-w-full rounded-[6px] border" />
		</button>
	);
}

export function ImageGallery({
	items,
	onOpenImage,
	inline = false,
	showCaptions = false,
}: {
	items: readonly GalleryItem[];
	/** Overrides the shared opener (useSessionMermaid().openImage). */
	onOpenImage?: (url: string) => void;
	/** Render the thumbnails as bare siblings (no wrapper), for transcript rows. */
	inline?: boolean;
	showCaptions?: boolean;
}) {
	const shared = useSessionMermaid()?.openImage;
	const open = onOpenImage ?? shared;
	const safe = useMemo(() => items.filter((i) => isRasterDataUrl(i.url)), [items]);
	if (safe.length === 0) return null;
	const thumbs = safe.map((item, i) =>
		showCaptions && item.caption ? (
			<figure key={i} className="m-0 w-fit max-w-full">
				<Thumb item={item} onOpen={open} />
				<figcaption className="truncate text-xs text-muted-foreground">{item.caption}</figcaption>
			</figure>
		) : (
			<Thumb key={i} item={item} onOpen={open} />
		),
	);
	if (inline) {
		return (
			<Fragment>
				{thumbs}
			</Fragment>
		);
	}
	return (
		<div data-testid="image-gallery" className="my-1 flex flex-wrap items-start gap-2">
			{thumbs}
		</div>
	);
}
