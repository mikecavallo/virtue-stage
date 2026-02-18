# VirtualStage Pro - Virtual Staging Website

A professional virtual staging website built for real estate agents. Transform empty rooms into beautifully staged spaces using AI-powered virtual staging technology.

## Features

- **Landing Page**: Professional homepage explaining the virtual staging service
- **Upload Form**: Easy-to-use interface for uploading room photos
- **Style Selection**: Choose from 6 different staging styles:
  - Modern
  - Traditional
  - Minimalist
  - Bohemian
  - Scandinavian
  - Luxury
- **"Let Us Choose" Option**: Allow the AI to select the best style automatically
- **Results Display**: Before/after comparison view of staged rooms
- **Pricing Section**: Transparent pricing tiers for different user needs
- **Responsive Design**: Works perfectly on desktop and mobile devices

## Tech Stack

- **Frontend Framework**: React 18
- **Styling**: Tailwind CSS
- **UI Components**: shadcn/ui
- **Build Tool**: Vite
- **Icons**: Lucide React

## Getting Started

### Prerequisites

- Node.js 18+ 
- npm or yarn

### Installation

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
npm run dev
```

3. Open your browser and navigate to `http://localhost:5173`

### Build for Production

```bash
npm run build
```

## Project Structure

```
src/
├── components/
│   ├── ui/              # shadcn/ui components
│   └── sections/        # Custom section components
├── lib/                 # Utility functions
├── App.jsx             # Main application component
├── main.jsx            # React entry point
└── index.css           # Global styles with Tailwind directives
```

## Backend Integration

This frontend is designed to integrate with a backend staging engine located at:
`/home/mike/.openclaw/workspace/virtual-staging/engine/`

### Integration Points

1. **File Upload**: The upload form collects files and sends them to the backend API
2. **Style Selection**: User-selected styles are passed to the staging engine
3. **Results Display**: Processed images are fetched from the backend and displayed

### API Endpoints (To be implemented)

```javascript
// Example API integration points
POST /api/staging/upload    // Upload room photos
GET  /api/staging/status    // Check processing status
GET  /api/staging/results   // Fetch staged results
POST /api/staging/download  // Download high-resolution images
```

### Environment Variables

Create a `.env.local` file for environment-specific configuration:

```env
VITE_API_BASE_URL=http://localhost:3001/api
VITE_MAX_FILE_SIZE=10485760  # 10MB
VITE_ALLOWED_FORMATS=image/jpeg,image/png,image/gif
```

## Design Principles

- **Professional**: Clean, modern design targeting real estate professionals
- **User-Friendly**: Intuitive interface with clear calls-to-action
- **Responsive**: Mobile-first approach ensuring accessibility on all devices
- **Fast**: Optimized performance with lazy loading and efficient state management

## Customization

### Styling
- Modify `tailwind.config.js` for theme customization
- Update color schemes in `src/index.css`
- Customize component styles in individual components

### Content
- Update pricing information in the Pricing section
- Modify feature descriptions in the Landing section
- Customize company information in the Footer

## Deployment

The application can be deployed to any static hosting service:

- **Vercel**: `vercel --prod`
- **Netlify**: `npm run build && netlify deploy --prod --dir dist`
- **GitHub Pages**: Use GitHub Actions with the build output

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

Proprietary software for VirtualStage Pro. All rights reserved.

## Support

For technical support or questions about the virtual staging service:
- Email: support@virtualstagepro.com
- Documentation: [Coming Soon]
- API Reference: [Coming Soon]

---

**Note**: This is the frontend interface. The AI staging engine integration is pending backend development completion.