import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
const icon = readFileSync(new URL("../src/app/icon.svg", import.meta.url), "utf8");

describe("monochrome UI contract", () => {
  it("keeps every CSS and favicon hex color achromatic", () => {
    const values = [...(css + icon).matchAll(/#([\da-f]{3,8})\b/gi)].map(match => match[1]);
    expect(values.length).toBeGreaterThan(20);
    for (const value of values) {
      const full = value.length <= 4 ? [...value].map(char => char + char).join("") : value;
      expect(full.slice(0, 2), value).toBe(full.slice(2, 4));
      expect(full.slice(2, 4), value).toBe(full.slice(4, 6));
    }
  });

  it("keeps all RGB shadows neutral and avoids colored themes", () => {
    for (const match of css.matchAll(/rgba?\(([^)]+)\)/g)) {
      const channels = match[1].split(/[\s,/]+/).slice(0, 3).map(Number);
      expect(channels[0]).toBe(channels[1]);
      expect(channels[1]).toBe(channels[2]);
    }
    expect(css).not.toMatch(/(?:hsl|hwb|lab|lch|oklab|oklch|color)\(/);
    expect(css).not.toMatch(/:\s*(?:red|green|blue|purple|orange|yellow|pink|teal)\b/i);
    expect(css).toContain("color-scheme: light");
  });
});
