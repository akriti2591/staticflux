/**
 * Browser entry of every page. The HTML is complete without it; this boots the site's
 * StaticFlux app and lets the islands hydrate on their triggers (visible / idle / interaction).
 */
import '../styles/site.css';
import { bootSite } from './app.js';

void bootSite();
