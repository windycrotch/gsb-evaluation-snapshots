// Babel 7 config used exclusively by Jest (babel-jest). The legacy webpack
// build uses Babel 6 with inline loader presets and does not read this file.
module.exports = {
  presets: [
    [ '@babel/preset-env', { targets: { node: 'current' } } ],
    '@babel/preset-react'
  ]
};
