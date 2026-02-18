# Backend Integration Guide

This guide explains how to connect the VirtualStage Pro frontend to the AI staging engine.

## Overview

The frontend is designed to work with a backend staging engine located at:
`/home/mike/.openclaw/workspace/virtual-staging/engine/`

## Integration Points

### 1. File Upload Handler

**Location**: `src/App.jsx` - `handleSubmit()` function

**Current Implementation** (mock):
```javascript
const handleSubmit = (event) => {
  event.preventDefault()
  console.log('Submitting:', { selectedFiles, selectedStyle, letUsChoose })
  setCurrentSection('results')
}
```

**Required Implementation**:
```javascript
import { api } from '@/config/api'

const handleSubmit = async (event) => {
  event.preventDefault()
  setIsProcessing(true)
  
  try {
    // Upload files and start staging
    const result = await api.uploadForStaging(
      selectedFiles, 
      selectedStyle, 
      letUsChoose
    )
    
    // Store job ID for status tracking
    setJobId(result.jobId)
    
    // Start polling for results
    pollForResults(result.jobId)
    
  } catch (error) {
    console.error('Staging failed:', error)
    // Handle error state
  }
}
```

### 2. Results Polling

**Add to App.jsx**:
```javascript
const pollForResults = async (jobId) => {
  const maxAttempts = 60 // 5 minutes max
  let attempts = 0
  
  const poll = async () => {
    try {
      const status = await api.checkStatus(jobId)
      
      if (status.completed) {
        const results = await api.getResults(jobId)
        setResults(results)
        setCurrentSection('results')
        setIsProcessing(false)
      } else if (attempts < maxAttempts) {
        attempts++
        setTimeout(poll, 5000) // Poll every 5 seconds
      } else {
        throw new Error('Staging timeout')
      }
    } catch (error) {
      console.error('Polling error:', error)
      setIsProcessing(false)
    }
  }
  
  poll()
}
```

### 3. Results Display Update

**Location**: `src/App.jsx` - Results section

**Replace mock data**:
```javascript
// Remove mockBeforeAfter array
// Update results section to use real data:

{results && results.length > 0 ? (
  results.map((result, index) => (
    <Card key={index} className="overflow-hidden">
      <CardHeader>
        <CardTitle>{result.roomName} - {result.style} Style</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <h4 className="font-semibold text-gray-700 mb-2">Before</h4>
            <img 
              src={result.originalImage} 
              alt="Before staging" 
              className="w-full h-64 object-cover rounded-lg border"
            />
          </div>
          <div>
            <h4 className="font-semibold text-gray-700 mb-2">After</h4>
            <img 
              src={result.stagedImage} 
              alt="After staging" 
              className="w-full h-64 object-cover rounded-lg border"
            />
          </div>
        </div>
        <div className="mt-6 flex justify-between items-center">
          <Button 
            variant="outline"
            onClick={() => downloadResult(result.id, 'preview')}
          >
            Download Preview
          </Button>
          <Button
            onClick={() => downloadResult(result.id, 'hires')}
          >
            Order High-Resolution
          </Button>
        </div>
      </CardContent>
    </Card>
  ))
) : (
  <div className="text-center py-12">
    <p>No results available.</p>
  </div>
)}
```

### 4. Environment Configuration

**Create `.env.local`**:
```env
VITE_API_BASE_URL=http://localhost:3001/api
VITE_BACKEND_ENGINE_PATH=/home/mike/.openclaw/workspace/virtual-staging/engine/
VITE_MAX_FILE_SIZE=10485760
VITE_SHOW_MOCK_RESULTS=false
```

### 5. Backend API Requirements

The backend engine should provide these endpoints:

#### POST `/api/staging/upload`
**Request**: FormData with files and options
```javascript
{
  room_0: File,
  room_1: File,
  // ... additional files
  style: "modern" | "traditional" | "minimalist" | "bohemian" | "scandinavian" | "luxury" | "auto",
  autoSelect: "true" | "false"
}
```

**Response**:
```javascript
{
  jobId: "unique-job-id",
  status: "processing",
  estimatedTime: 180 // seconds
}
```

#### GET `/api/staging/status/:jobId`
**Response**:
```javascript
{
  jobId: "unique-job-id",
  status: "processing" | "completed" | "failed",
  progress: 75, // percentage
  estimatedTimeRemaining: 45 // seconds
}
```

#### GET `/api/staging/results/:jobId`
**Response**:
```javascript
{
  jobId: "unique-job-id",
  results: [
    {
      id: "result-1",
      roomName: "Living Room",
      style: "modern",
      originalImage: "/api/images/original/abc123.jpg",
      stagedImage: "/api/images/staged/abc123.jpg",
      thumbnailImage: "/api/images/thumbs/abc123.jpg"
    }
    // ... additional results
  ]
}
```

#### GET `/api/staging/download/:jobId`
**Query params**: `format=preview|hires|zip`
**Response**: Binary file download

## Quick Integration Steps

1. **Start Backend Engine**: Ensure the engine is running on expected port
2. **Update API Config**: Modify `src/config/api.js` endpoints
3. **Update Upload Handler**: Replace mock submission with real API calls
4. **Add Status Polling**: Implement progress tracking
5. **Update Results Display**: Replace mock data with real results
6. **Test End-to-End**: Upload → Process → Display workflow

## Error Handling

Add these error states to the frontend:

```javascript
// Add to App.jsx state
const [error, setError] = useState(null)
const [isProcessing, setIsProcessing] = useState(false)

// Error display component
{error && (
  <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-4">
    <div className="flex">
      <div className="flex-shrink-0">
        <XCircleIcon className="h-5 w-5 text-red-400" />
      </div>
      <div className="ml-3">
        <h3 className="text-sm font-medium text-red-800">
          Processing Error
        </h3>
        <div className="mt-2 text-sm text-red-700">
          {error}
        </div>
      </div>
    </div>
  </div>
)}
```

## Testing

1. **Manual Testing**: Use browser dev tools to test API calls
2. **File Validation**: Test various file types and sizes
3. **Error Scenarios**: Test network failures, timeout scenarios
4. **Performance**: Test with multiple large files

## Production Considerations

- **CORS**: Configure backend to allow frontend origin
- **Rate Limiting**: Implement upload rate limits
- **File Storage**: Configure secure file upload/download
- **Authentication**: Add user authentication if required
- **Monitoring**: Add error tracking and performance monitoring

---

**Note**: This frontend is ready for integration. Update the API configuration and handlers as outlined above to connect with the backend engine.