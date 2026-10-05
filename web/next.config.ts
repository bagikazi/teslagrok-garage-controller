import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@garage-control/shared-types"],
  typedRoutes: true
};

export default nextConfig;
