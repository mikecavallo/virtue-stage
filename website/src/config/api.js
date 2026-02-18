// API Configuration for Virtual Staging Backend Integration

// Base configuration
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3099/api'
const MAX_FILE_SIZE = import.meta.env.VITE_MAX_FILE_SIZE || 10485760 // 10MB
const ALLOWED_FORMATS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

// API Endpoints
export const endpoints = {
  // Upload endpoints
  upload: `${API_BASE_URL}/staging/upload`,
  status: `${API_BASE_URL}/staging/status`,
  results: `${API_BASE_URL}/staging/results`,
  download: `${API_BASE_URL}/staging/download`,
  
  // Utility endpoints
  health: `${API_BASE_URL}/health`,
  styles: `${API_BASE_URL}/staging/styles`,
}

// Configuration constants
export const config = {
  maxFileSize: MAX_FILE_SIZE,
  allowedFormats: ALLOWED_FORMATS,
  maxFilesPerUpload: 10,
  supportedStyles: [
    'modern',
    'traditional', 
    'minimalist',
    'bohemian',
    'scandinavian',
    'luxury'
  ]
}

// API Helper Functions
export const api = {
  // Upload room photos for staging
  async uploadForStaging(files, style, letUsChoose = false) {
    const formData = new FormData()
    
    // Add files to form data
    files.forEach((file, index) => {
      formData.append(`room_${index}`, file)
    })
    
    // Add staging options
    formData.append('style', letUsChoose ? 'auto' : style)
    formData.append('autoSelect', letUsChoose.toString())
    
    try {
      const response = await fetch(endpoints.upload, {
        method: 'POST',
        body: formData,
      })
      
      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`)
      }
      
      return await response.json()
    } catch (error) {
      console.error('Upload error:', error)
      throw error
    }
  },

  // Check staging status
  async checkStatus(jobId) {
    try {
      const response = await fetch(`${endpoints.status}/${jobId}`)
      
      if (!response.ok) {
        throw new Error(`Status check failed: ${response.statusText}`)
      }
      
      return await response.json()
    } catch (error) {
      console.error('Status check error:', error)
      throw error
    }
  },

  // Get staging results
  async getResults(jobId) {
    try {
      const response = await fetch(`${endpoints.results}/${jobId}`)
      
      if (!response.ok) {
        throw new Error(`Failed to fetch results: ${response.statusText}`)
      }
      
      return await response.json()
    } catch (error) {
      console.error('Results fetch error:', error)
      throw error
    }
  },

  // Download high-resolution images
  async downloadImages(jobId, format = 'zip') {
    try {
      const response = await fetch(`${endpoints.download}/${jobId}?format=${format}`)
      
      if (!response.ok) {
        throw new Error(`Download failed: ${response.statusText}`)
      }
      
      return response.blob()
    } catch (error) {
      console.error('Download error:', error)
      throw error
    }
  },

  // Check backend health
  async checkHealth() {
    try {
      const response = await fetch(endpoints.health)
      return response.ok
    } catch (error) {
      console.error('Health check failed:', error)
      return false
    }
  }
}

// File validation helpers
export const validation = {
  isValidFileType(file) {
    return ALLOWED_FORMATS.includes(file.type)
  },

  isValidFileSize(file) {
    return file.size <= MAX_FILE_SIZE
  },

  validateFiles(files) {
    const errors = []
    
    files.forEach((file, index) => {
      if (!validation.isValidFileType(file)) {
        errors.push(`File ${index + 1}: Invalid file type. Please use JPEG, PNG, GIF, or WebP.`)
      }
      
      if (!validation.isValidFileSize(file)) {
        errors.push(`File ${index + 1}: File too large. Maximum size is ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB.`)
      }
    })
    
    if (files.length > config.maxFilesPerUpload) {
      errors.push(`Too many files. Maximum ${config.maxFilesPerUpload} files allowed per upload.`)
    }
    
    return errors
  }
}

export default api