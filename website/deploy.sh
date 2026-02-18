#!/bin/bash

# VirtualStage Pro - Deployment Script

echo "🚀 Starting deployment process for VirtualStage Pro..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed. Please install npm first."
    exit 1
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "❌ Failed to install dependencies."
    exit 1
fi

# Run lint check
echo "🔍 Running lint check..."
npm run lint

if [ $? -ne 0 ]; then
    echo "⚠️ Lint errors found. Continuing with build..."
fi

# Build the application
echo "🏗️ Building application for production..."
npm run build

if [ $? -ne 0 ]; then
    echo "❌ Build failed."
    exit 1
fi

echo "✅ Build completed successfully!"

# Check if dist directory exists
if [ ! -d "dist" ]; then
    echo "❌ Build output directory not found."
    exit 1
fi

echo "📁 Build output size:"
du -sh dist/

echo ""
echo "🎉 Deployment build complete!"
echo ""
echo "📋 Next steps:"
echo "  1. Upload the 'dist' folder to your web server"
echo "  2. Configure your web server to serve the index.html file"
echo "  3. Set up environment variables on your hosting platform"
echo "  4. Test the deployed application"
echo ""
echo "📝 Deploy locations:"
echo "  - Static hosting: Upload dist/* to your hosting provider"
echo "  - Vercel: vercel --prod"
echo "  - Netlify: netlify deploy --prod --dir dist"
echo "  - GitHub Pages: Use GitHub Actions with dist/ output"
echo ""

# Optionally start preview server
read -p "🖥️ Start preview server? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "🌐 Starting preview server on http://localhost:3000"
    echo "Press Ctrl+C to stop"
    npm run start
fi