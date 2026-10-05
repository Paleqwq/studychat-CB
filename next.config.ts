import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  // Isolated local QA builds must not overwrite a running production build.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  devIndicators: false,
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" }
      ]
    }, {
      source: "/api/:path*",
      headers: [{ key: "Cache-Control", value: "no-store" }]
    }];
  }
};
export default config;
