/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['@anthropic-ai/sdk'],
  },
  webpack: (config, { isServer }) => {
    // pdfjs-dist needs canvas on server side but we only use it client-side
    if (isServer) {
      config.externals.push('canvas');
    }
    return config;
  },
};

module.exports = nextConfig;
