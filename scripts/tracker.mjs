export const trackerScript = '<script defer src="https://gllrain.world/site-stats/script.js" data-website-id="7bc56d7d-98da-41d4-9ca9-f107650f6763" data-domains="cooleryu.github.io"></script>';

export function withTracker(html) {
  if (html.includes(trackerScript)) return html;
  if (!html.includes("</head>")) throw new Error("Cannot install tracker: missing </head>.");
  return html.replace("</head>", `  ${trackerScript}\n</head>`);
}
