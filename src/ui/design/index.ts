/**
 * Design system entry (T-018): importing this module installs the global stylesheet (tokens, base
 * styles, component styles) and re-exports the token values code needs (canvas colours etc.).
 * The app imports it once from `src/main.ts`; screens import components from `src/ui/components`.
 * @module
 */
import './tokens.css';
import './base.css';
import '../components/components.css';

export * from './tokens';
