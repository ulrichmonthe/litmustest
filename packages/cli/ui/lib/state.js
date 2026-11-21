// litmustest dashboard: lib/state.js
import { render } from "../router.js";

export const state = { health: null, modes: [], batches: [], route: [], query: {}, seq: 0, promoted: null };
/** A render that started before a later navigation must not replace the page. */
export const stale = (seq) => seq !== state.seq;
