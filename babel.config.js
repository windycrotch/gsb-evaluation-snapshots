/**
 * Babel 7 config used solely by Jest (babel-jest).
 * The library's own webpack build keeps using Babel 6 with inline presets
 * and does not read this file.
 */
module.exports = {
  presets: [
    ['@babel/preset-env', { targets: { node: 'current' } }],
    '@babel/preset-react'
  ]
};
