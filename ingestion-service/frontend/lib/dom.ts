/**
 * DOM helpers shared by the panels.
 *
 * Every panel used to start with six `document.getElementById(...)`
 * calls whose results are `HTMLElement | null`, which the old JS simply
 * ignored. In TypeScript that forces a null-check on every use. The panel
 * elements are part of map.html's static markup, so "must exist" is a real
 * invariant of the page — this helper centralizes that assertion in one
 * place instead of sprinkling `!` casts through the panels.
 */

/**
 * Get a page element by id, failing if the markup is missing it.
 * Use only for elements that map.html always defines (panel scaffolding).
 * For optional elements (e.g. the transient `#data-age` span) use plain
 * `document.getElementById` and keep the null guard.
 */
export function mustGetElement<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) {
        throw new Error(`Missing #${id}. Is map.html out of sync with the frontend modules?`);
    }
    return el as T;
}
