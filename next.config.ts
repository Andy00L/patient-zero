import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The dev route-type badge is hidden. It floats over the bottom-left of every surface, which
   * is where the propagation trace's outer hop rings sit, so it lands on top of the one element
   * a screenshot or the demo recording has to show. Compile and runtime errors are still
   * surfaced with this off, so nothing diagnostic is lost.
   */
  devIndicators: false,
};

export default nextConfig;
