/**
 * The panel stylesheet.
 *
 * Two rules make plugin UI look like the Harness rather than beside it:
 *
 *  - every color is a `--dsw-alias-*` theme token, never a literal, so light
 *    and dark both work and a renamed token degrades instead of breaking;
 *  - the tag is created from the bundle's own factory body, so the client
 *    module system claims it and removes it when the plugin is disabled.
 *
 * Class names carry the plugin's `dra-` prefix so two plugins can never collide.
 *
 * @module dsh-remote-access/client/styles
 */

/** Id of the stylesheet tag, so injection stays idempotent. */
export const STYLE_ID = 'dsh-remote-access-style'

/** Theme-token-only stylesheet for the panel. */
export const PANEL_CSS = `
.dra-page{height:100%;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;-webkit-font-smoothing:antialiased}
.dra-inner{max-width:960px;margin:0 auto;padding:0 clamp(24px,4vw,48px) 48px;display:flex;flex-direction:column;gap:24px}
.dra-header{padding-top:28px}
[data-platform=darwin] .dra-header{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
.dra-titleRow{display:flex;align-items:center;flex-wrap:wrap}
.dra-title{margin:0;font-size:20px;font-weight:500;line-height:28px}
.dra-chip{margin-left:6px;padding:1px 8px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-caption);font-size:12px;font-weight:500;line-height:18px;white-space:nowrap;font-variant-numeric:tabular-nums}
.dra-intro{margin:6px 0 0;max-width:64ch;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}

.dra-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:20px;display:flex;flex-direction:column;gap:14px}
.dra-cardHead{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dra-subtitle{margin:0;font-size:13px;font-weight:600;line-height:20px}
.dra-facts{margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px 24px}
.dra-fact{display:flex;flex-direction:column;gap:2px;min-width:0}
.dra-fact dt{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dra-fact dd{margin:0;font-size:13px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}

.dra-pill{padding:2px 10px;border-radius:999px;font-size:11px;font-weight:500;line-height:16px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
.dra-pill-on{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.dra-pill-wait{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent)}

.dra-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.dra-button{appearance:none;border:0;border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;line-height:20px;cursor:pointer;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);transition:background .12s ease}
.dra-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.dra-button:disabled{opacity:.45;cursor:default}
.dra-button-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dra-button-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dra-button-danger{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.dra-button-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent)}

.dra-note{border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dra-note strong{display:block;color:var(--dsw-alias-label-primary);font-weight:600;font-size:13px}
.dra-note p{margin:2px 0 0}
.dra-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);max-width:72ch}
.dra-warning{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary)}
.dra-error{margin:0;padding:10px 12px;border-radius:10px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.dra-errorInline{margin-top:-4px}

.dra-links{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.dra-linkRow{display:flex;align-items:center;gap:8px;min-width:0}
.dra-input{width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:6px 10px}
.dra-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dra-inputMono{font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px}
.dra-secret{position:relative;display:flex;flex:1;min-width:0}
.dra-inputSecret{padding-right:34px}
.dra-eye{position:absolute;right:4px;top:50%;transform:translateY(-50%);width:26px;height:26px;display:grid;place-items:center;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dra-eye:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dra-inputShort{width:110px;font-variant-numeric:tabular-nums}

.dra-field{display:flex;flex-direction:column;gap:6px;max-width:560px}
.dra-fieldRow{gap:4px}
.dra-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dra-switchLabel{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-primary);cursor:pointer}
.dra-switchLabel input{accent-color:var(--dsw-alias-brand-primary)}
.dra-saved{font-size:12px;color:var(--dsw-alias-state-success-primary)}
.dra-saved-warn{color:var(--dsw-alias-state-warn-primary)}
`

/** Append the stylesheet once per document. */
export function injectStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = PANEL_CSS
  document.head.append(style)
}