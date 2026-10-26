/**
 * "What is this?" help panel (top-right corner).
 *
 * WHAT THIS FILE OWNS:
 *   - open/close on button click
 *   - close on Escape
 *   - close when clicking outside the panel and button
 */

import { mustGetElement } from '../lib/dom.js';

/**
 * Wire up the info panel. Call once at startup (from the map entry module).
 * The button and panel are static markup in map.html, so "must exist" is a
 * real page invariant, and mustGetElement asserts it.
 */
export function initInfoToggle(): void {
    const toggle = mustGetElement<HTMLButtonElement>('info-toggle');
    const panel = mustGetElement<HTMLElement>('info-panel');

    toggle.addEventListener('click', () => {
        const open = panel.style.display === 'block';
        panel.style.display = open ? 'none' : 'block';
        toggle.classList.toggle('active', !open);
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && panel.style.display === 'block') {
            panel.style.display = 'none';
            toggle.classList.remove('active');
        }
    });

    // Close when clicking outside the panel and button
    document.addEventListener('click', (e) => {
        const target = e.target as Node | null;
        if (target && !toggle.contains(target) && !panel.contains(target)) {
            panel.style.display = 'none';
            toggle.classList.remove('active');
        }
    });
}
