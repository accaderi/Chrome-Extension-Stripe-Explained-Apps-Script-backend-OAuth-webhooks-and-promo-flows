const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const webpack = require('webpack');
require('dotenv').config();

module.exports = {
  entry: {
    main: './main.js',
    background: './background.js',
  },
  output: {
    filename: '[name].bundle.js',
    path: path.resolve(__dirname, 'dist'),
    clean: true
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: "main.html", to: "main.html" },
        { from: "manifest.json", to: "manifest.json" },
        { from: "icon_sample_16.png", to: "icon_sample_16.png" },
        { from: "icon_sample_48.png", to: "icon_sample_48.png" },
        { from: "icon_sample_128.png", to: "icon_sample_128.png" }
      ]
    }),
    new webpack.DefinePlugin({
      'process.env.VERIFICATION_ENDPOINT': JSON.stringify(process.env.VERIFICATION_ENDPOINT)
    })
  ]
};