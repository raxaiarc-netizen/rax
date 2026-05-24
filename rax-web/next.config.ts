import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: '2mb' },
  },
  async headers() {
    return [
      {
        source: '/v1/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'POST,OPTIONS' },
          {
            key: 'Access-Control-Allow-Headers',
            value: 'Authorization,Content-Type,X-Api-Key,Anthropic-Version,Anthropic-Beta',
          },
        ],
      },
    ]
  },
}

export default nextConfig
