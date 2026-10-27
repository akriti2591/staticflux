/**
 * `<if-home>`'s styles (C0; B11c HOME-FILES §1–§4 on the design `docs/instaflow/design/HomeCP.dc.html`): the 64 px
 * header, the 1180 px page column, Bricolage section headings, cards (18 px), the 4 / 3 / 2 column grids, list rows
 * (44 px), the bulk bar, the trash rows and the footer. Theme tokens only.
 */
import { themeTokens as t } from '@staticflux/ui/theme';
import { css } from 'lit';

export const homeStyles = css`
  :host {
    display: block;
    min-block-size: 100vh;
    background: ${t.color.canvas.css};
    color: ${t.color.text.css};
    font-family: ${t.font.family.css};
    font-size: ${t.type.sizeMd.css};
    line-height: ${t.type.lineNormal.css};
  }
  .top {
    position: sticky;
    inset-block-start: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: ${t.space.lg.css};
    flex-wrap: wrap;
    min-block-size: 64px;
    padding-inline: 28px;
    box-sizing: border-box;
    background: ${t.color.canvas.css};
    border-block-end: 1px solid ${t.color.border.css};
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: ${t.color.text.css};
    text-decoration: none;
    border-radius: ${t.radius.md.css};
    font-family: ${t.font.familyDisplay.css};
    font-weight: ${t.font.weightDisplay.css};
    font-size: 21px;
    letter-spacing: -0.02em;
  }
  a:focus-visible,
  button:focus-visible,
  input:focus-visible {
    outline: 2px solid ${t.color.focusRing.css};
    outline-offset: 2px;
  }
  .nav {
    display: inline-flex;
    gap: 2px;
    padding: 3px;
    margin: 0;
    border-radius: 999px;
    background: ${t.color.neutral3.css};
    list-style: none;
  }
  .nav a {
    display: inline-flex;
    align-items: center;
    min-block-size: 28px;
    padding-inline: 12px;
    border-radius: 999px;
    color: ${t.color.textMuted.css};
    font-size: ${t.type.sizeSm.css};
    font-weight: ${t.font.weightSemibold.css};
    text-decoration: none;
  }
  .nav a:hover {
    color: ${t.color.text.css};
  }
  .nav a[aria-current='page'] {
    background: ${t.color.surface2.css};
    color: ${t.color.text.css};
    box-shadow: ${t.shadow.level1.css};
  }
  .search {
    flex: 1 1 200px;
    max-inline-size: 360px;
  }
  .new {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    margin-inline-start: auto;
  }
  main {
    display: flex;
    flex-direction: column;
    gap: 44px;
    max-inline-size: 1180px;
    margin-inline: auto;
    padding: 40px 28px 64px;
    box-sizing: border-box;
    border-radius: ${t.radius.lg.css};
  }
  main.drop {
    outline: 2px dashed ${t.color.accent.css};
    outline-offset: -8px;
  }
  .hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 20px;
    text-align: center;
  }
  h1 {
    margin: 0;
    max-inline-size: 900px;
    font-family: ${t.font.familyDisplay.css};
    font-weight: ${t.font.weightDisplay.css};
    font-size: clamp(40px, 6vw, 72px);
    line-height: 1;
    letter-spacing: -0.035em;
  }
  h1.page-title {
    font-size: 32px;
    letter-spacing: -0.02em;
  }
  .bold {
    padding-inline: 10px;
    border-radius: 14px;
    background: var(--if-home-bold, transparent);
    color: var(--if-home-bold-ink, inherit);
  }
  .lead {
    margin: 0;
    max-inline-size: 560px;
    color: ${t.color.textMuted.css};
    font-size: ${t.type.sizeLg.css};
  }
  .formats {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: ${t.space.sm.css};
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .formats sf-button .size,
  .mono {
    font-family: ${t.font.familyMono.css};
    color: ${t.color.textMuted.css};
    font-size: ${t.type.sizeXs.css};
  }
  section {
    display: flex;
    flex-direction: column;
    gap: ${t.space.lg.css};
  }
  .section-head {
    display: flex;
    align-items: center;
    gap: ${t.space.md.css};
    flex-wrap: wrap;
  }
  .section-head .push {
    margin-inline-start: auto;
  }
  h2 {
    margin: 0;
    font-family: ${t.font.familyDisplay.css};
    font-weight: ${t.font.weightDisplay.css};
    font-size: 24px;
    letter-spacing: -0.01em;
  }
  h3 {
    margin: 0;
    font-size: ${t.type.sizeSm.css};
    font-weight: ${t.font.weightSemibold.css};
    color: ${t.color.textMuted.css};
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  @media (min-width: 900px) {
    .grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }
  @media (min-width: 1180px) {
    .grid {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
  }
  .grid > li {
    display: contents;
  }
  .quick .grid {
    grid-template-columns: repeat(auto-fill, minmax(min(190px, 100%), 1fr));
  }
  .quick sf-card {
    min-block-size: 136px;
  }
  .card-title {
    font-family: ${t.font.familyDisplay.css};
    font-weight: 700;
    font-size: 17px;
    letter-spacing: -0.01em;
  }
  .muted {
    color: ${t.color.textMuted.css};
    font-size: ${t.type.sizeSm.css};
  }
  .tile {
    --kit-card-padding: 0;
    --kit-card-gap: 10px;
  }
  .tile::part(card) {
    border: 0;
    background: transparent;
  }
  .tile[selected]::part(card) {
    background: transparent;
  }
  .thumb {
    position: relative;
    display: grid;
    place-items: center;
    align-self: stretch;
    block-size: 158px;
    border-radius: ${t.radius.lg.css};
    background: ${t.color.neutral3.css};
    overflow: hidden;
  }
  .tile[selected] .thumb {
    box-shadow: 0 0 0 2px ${t.color.accent.css};
  }
  .page {
    max-block-size: 118px;
    border-radius: ${t.radius.sm.css};
    background: ${t.color.surface1.css};
    box-shadow: ${t.shadow.level1.css};
  }
  .preview {
    inline-size: 100%;
    block-size: 100%;
    object-fit: cover;
  }
  .thumb sf-tag {
    position: absolute;
    inset-block-start: 10px;
    inset-inline-start: 10px;
  }
  .tile[selectable] .thumb sf-tag {
    inset-inline-start: 40px;
  }
  .star-mark {
    position: absolute;
    inset-block-end: 10px;
    inset-inline-end: 10px;
    color: ${t.color.accent.css};
  }
  .tile-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-inline: 2px;
    min-inline-size: 0;
    align-self: stretch;
  }
  .tile-title {
    font-weight: ${t.font.weightSemibold.css};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  mark {
    background: ${t.color.accentSubtle.css};
    color: inherit;
    border-radius: 3px;
  }
  .card-action {
    --kit-icon-button-bg: ${t.color.surface2.css};
  }
  .check {
    inline-size: 18px;
    block-size: 18px;
    margin: 6px;
    accent-color: ${t.color.accent.css};
  }
  .project-card {
    --kit-card-gap: 6px;
    min-block-size: 104px;
  }
  .project-card .folder {
    color: ${t.color.textMuted.css};
  }
  .new-project {
    display: flex;
    flex-direction: column;
    gap: ${t.space.sm.css};
    padding: ${t.space.lg.css};
    border: 1px dashed ${t.color.controlEdge.css};
    border-radius: ${t.radius.lg.css};
  }
  .empty {
    margin: 0;
    color: ${t.color.textMuted.css};
  }
  .welcome {
    display: flex;
    flex-direction: column;
    gap: ${t.space.sm.css};
    max-inline-size: 760px;
    padding: 22px 24px;
    border: 1px solid ${t.color.border.css};
    border-radius: ${t.radius.lg.css};
    background: ${t.color.surface2.css};
    position: relative;
  }
  .welcome h2 {
    font-size: 20px;
  }
  .welcome p {
    margin: 0;
    color: ${t.color.textMuted.css};
  }
  .welcome .row {
    display: flex;
    gap: ${t.space.sm.css};
    align-items: center;
    flex-wrap: wrap;
    margin-block-start: ${t.space.xs.css};
  }
  .welcome .close {
    position: absolute;
    inset-block-start: 12px;
    inset-inline-end: 12px;
  }
  .problem {
    display: flex;
    align-items: center;
    gap: ${t.space.md.css};
    flex-wrap: wrap;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: ${t.space.sm.css};
    flex-wrap: wrap;
  }
  .toolbar .push {
    margin-inline-start: auto;
  }
  .list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid ${t.color.border.css};
    border-radius: ${t.radius.lg.css};
    background: ${t.color.surface2.css};
    overflow: hidden;
  }
  .row {
    display: grid;
    grid-template-columns: 28px 32px minmax(0, 2fr) 96px minmax(0, 1fr) minmax(0, 1fr) 96px 34px;
    align-items: center;
    gap: ${t.space.md.css};
    min-block-size: 44px;
    padding-inline: ${t.space.md.css};
  }
  .list .row + .row {
    border-block-start: 1px solid ${t.color.border.css};
  }
  .row.head {
    min-block-size: 32px;
    color: ${t.color.textMuted.css};
    font-size: ${t.type.sizeXs.css};
    font-weight: ${t.font.weightSemibold.css};
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .row sf-tag {
    justify-self: start;
  }
  .row[data-selected] {
    background: ${t.color.accentSubtle.css};
  }
  .row .check {
    opacity: 0;
  }
  .row:hover .check,
  .row:focus-within .check,
  .row[data-selected] .check,
  .list[data-selecting] .check {
    opacity: 1;
  }
  .row .mark {
    inline-size: 32px;
    block-size: 32px;
    border-radius: ${t.radius.sm.css};
    background: ${t.color.neutral3.css};
    display: grid;
    place-items: center;
    overflow: hidden;
  }
  .row a,
  .row .name {
    color: ${t.color.text.css};
    font-weight: ${t.font.weightMedium.css};
    text-decoration: none;
    border-radius: ${t.radius.sm.css};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row a:hover {
    text-decoration: underline;
  }
  .row .cell {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: ${t.color.textMuted.css};
    font-size: ${t.type.sizeSm.css};
  }
  .bulk {
    position: fixed;
    inset-block-end: 24px;
    inset-inline-start: 50%;
    transform: translateX(-50%);
    z-index: 3;
    display: flex;
    align-items: center;
    gap: ${t.space.sm.css};
    min-block-size: 44px;
    padding-inline: 16px 6px;
    border: 1px solid ${t.color.border.css};
    border-radius: 999px;
    background: ${t.color.surface2.css};
    box-shadow: ${t.shadow.level3.css};
    animation: rise ${t.motion.durationNormal.css} ${t.motion.easeStandard.css};
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translate(-50%, 8px);
    }
  }
  .trash-day {
    display: flex;
    flex-direction: column;
    gap: ${t.space.sm.css};
  }
  .trash-row {
    grid-template-columns: 32px minmax(0, 2fr) 96px minmax(0, 1fr) auto;
  }
  .trash-actions {
    display: flex;
    gap: ${t.space.xs.css};
    align-items: center;
    justify-content: flex-end;
  }
  .project-head {
    display: flex;
    align-items: center;
    gap: ${t.space.md.css};
    flex-wrap: wrap;
  }
  .project-head h1 {
    font-size: 24px;
  }
  .title-button {
    padding: 2px 6px;
    margin-inline-start: -6px;
    border: 0;
    border-radius: ${t.radius.md.css};
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: text;
  }
  .title-button:hover {
    background: ${t.color.neutral3.css};
  }
  footer.foot {
    max-inline-size: 1180px;
    margin-inline: auto;
    padding: 0 28px 40px;
    box-sizing: border-box;
    color: ${t.color.textMuted.css};
    font-size: ${t.type.sizeSm.css};
  }
  .sr-only {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  @media (prefers-reduced-motion: reduce) {
    .bulk {
      animation: none;
    }
  }
  @media (forced-colors: active) {
    .thumb,
    .list,
    .bulk {
      border: 1px solid CanvasText;
    }
    .nav a[aria-current='page'],
    .row[data-selected] {
      outline: 2px solid Highlight;
    }
  }
`;
