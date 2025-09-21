#!/usr/bin/env python3
"""
Crawl4AI Service
Web crawling service using crawl4ai for extracting markdown content
"""

import asyncio
import logging
import os
from typing import Optional, List, Dict, Any
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, HttpUrl
import uvicorn

try:
    from crawl4ai import AsyncWebCrawler, CrawlResult
    from crawl4ai.extraction_strategy import LLMExtractionStrategy
except ImportError:
    AsyncWebCrawler = None
    CrawlResult = None
    LLMExtractionStrategy = None

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI(
    title="Crawl4AI Service", 
    version="1.0.0",
    description="Web crawling service using crawl4ai for extracting markdown content"
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Pydantic models for API
class CrawlRequest(BaseModel):
    url: HttpUrl
    max_pages: Optional[int] = 1
    deep_crawl: Optional[bool] = False
    crawl_strategy: Optional[str] = "bfs"  # bfs, dfs
    wait_for: Optional[str] = None  # CSS selector to wait for
    delay_between_requests: Optional[float] = 1.0
    user_agent: Optional[str] = None
    headers: Optional[Dict[str, str]] = None
    extract_links: Optional[bool] = True
    extract_media: Optional[bool] = False
    word_count_threshold: Optional[int] = 10
    extraction_strategy: Optional[str] = None  # "llm", "cosine_similarity", "readability"
    extraction_query: Optional[str] = None  # For LLM extraction

class CrawlResponse(BaseModel):
    success: bool
    url: str
    markdown: Optional[str] = None
    html: Optional[str] = None
    links: Optional[List[str]] = None
    media: Optional[List[Dict[str, Any]]] = None
    metadata: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    pages_crawled: int = 1

class HealthResponse(BaseModel):
    status: str
    crawl4ai_available: bool
    service: str

def validate_url(url: str) -> bool:
    """Validate if URL is properly formatted"""
    try:
        result = urlparse(str(url))
        return all([result.scheme, result.netloc])
    except Exception:
        return False

async def crawl_single_page(url: str, request: CrawlRequest) -> CrawlResponse:
    """Crawl a single page"""
    if AsyncWebCrawler is None:
        raise HTTPException(status_code=503, detail="Crawl4AI not available")
    
    try:
        logger.info(f"Starting crawl for URL: {url}")
        
        # Prepare crawl parameters
        crawl_params = {
            "url": str(url),
            "wait_for": request.wait_for,
            "delay_between_requests": request.delay_between_requests,
            "extract_links": request.extract_links,
            "extract_media": request.extract_media,
            "word_count_threshold": request.word_count_threshold,
        }
        
        # Add user agent if provided
        if request.user_agent:
            crawl_params["user_agent"] = request.user_agent
        
        # Add headers if provided
        if request.headers:
            crawl_params["headers"] = request.headers
        
        # Add extraction strategy if provided
        if request.extraction_strategy == "llm" and request.extraction_query:
            crawl_params["extraction_strategy"] = LLMExtractionStrategy(
                provider="ollama/llama2",
                api_token="your-api-token",
                instruction=request.extraction_query
            )
        
        async with AsyncWebCrawler() as crawler:
            result = await crawler.arun(**crawl_params)
            
            if result.success:
                logger.info(f"Successfully crawled: {url}")
                # Extract links properly
                links_list = None
                if hasattr(result, 'links') and result.links:
                    if isinstance(result.links, dict):
                        # If links is a dict, extract all links from internal/external
                        all_links = []
                        if 'internal' in result.links:
                            all_links.extend([link.get('href', '') for link in result.links['internal'] if isinstance(link, dict)])
                        if 'external' in result.links:
                            all_links.extend([link.get('href', '') for link in result.links['external'] if isinstance(link, dict)])
                        links_list = all_links if all_links else None
                    elif isinstance(result.links, list):
                        links_list = result.links
                
                # Extract media properly
                media_list = None
                if hasattr(result, 'media') and result.media:
                    if isinstance(result.media, dict):
                        # If media is a dict, extract all media items
                        all_media = []
                        for media_type in ['images', 'videos', 'audios']:
                            if media_type in result.media and isinstance(result.media[media_type], list):
                                for item in result.media[media_type]:
                                    if isinstance(item, dict):
                                        all_media.append({
                                            'type': media_type[:-1],  # Remove 's' from end
                                            'url': item.get('src', item.get('url', '')),
                                            'alt': item.get('alt', ''),
                                            'title': item.get('title', '')
                                        })
                        media_list = all_media if all_media else None
                    elif isinstance(result.media, list):
                        media_list = result.media
                
                return CrawlResponse(
                    success=True,
                    url=str(url),  # Convert HttpUrl to string
                    markdown=result.markdown,
                    html=result.html,
                    links=links_list,
                    media=media_list,
                    metadata={
                        "title": getattr(result, 'title', None),
                        "description": getattr(result, 'description', None),
                        "word_count": getattr(result, 'word_count', None),
                        "crawl_timestamp": getattr(result, 'crawl_timestamp', None),
                    },
                    pages_crawled=1
                )
            else:
                logger.error(f"Failed to crawl: {url}")
                return CrawlResponse(
                    success=False,
                    url=str(url),  # Convert HttpUrl to string
                    error="Crawl failed - no content extracted",
                    pages_crawled=0
                )
                
    except Exception as e:
        logger.error(f"Error crawling {url}: {str(e)}")
        return CrawlResponse(
            success=False,
            url=str(url),  # Convert HttpUrl to string
            error=f"Crawl error: {str(e)}",
            pages_crawled=0
        )

async def crawl_multiple_pages(url: str, request: CrawlRequest) -> CrawlResponse:
    """Crawl multiple pages using deep crawl"""
    if AsyncWebCrawler is None:
        raise HTTPException(status_code=503, detail="Crawl4AI not available")
    
    try:
        logger.info(f"Starting deep crawl for URL: {url}, max_pages: {request.max_pages}")
        
        # Prepare crawl parameters for deep crawl
        crawl_params = {
            "url": str(url),
            "wait_for": request.wait_for,
            "delay_between_requests": request.delay_between_requests,
            "extract_links": request.extract_links,
            "extract_media": request.extract_media,
            "word_count_threshold": request.word_count_threshold,
            "max_pages": request.max_pages,
            "crawl_strategy": request.crawl_strategy,
        }
        
        # Add user agent if provided
        if request.user_agent:
            crawl_params["user_agent"] = request.user_agent
        
        # Add headers if provided
        if request.headers:
            crawl_params["headers"] = request.headers
        
        # Add extraction strategy if provided
        if request.extraction_strategy == "llm" and request.extraction_query:
            crawl_params["extraction_strategy"] = LLMExtractionStrategy(
                provider="ollama/llama2",
                api_token="your-api-token",
                instruction=request.extraction_query
            )
        
        async with AsyncWebCrawler() as crawler:
            result = await crawler.arun(**crawl_params)
            
            if result.success:
                logger.info(f"Successfully deep crawled: {url}")
                # Extract links properly
                links_list = None
                if hasattr(result, 'links') and result.links:
                    if isinstance(result.links, dict):
                        # If links is a dict, extract all links from internal/external
                        all_links = []
                        if 'internal' in result.links:
                            all_links.extend([link.get('href', '') for link in result.links['internal'] if isinstance(link, dict)])
                        if 'external' in result.links:
                            all_links.extend([link.get('href', '') for link in result.links['external'] if isinstance(link, dict)])
                        links_list = all_links if all_links else None
                    elif isinstance(result.links, list):
                        links_list = result.links
                
                # Extract media properly
                media_list = None
                if hasattr(result, 'media') and result.media:
                    if isinstance(result.media, dict):
                        # If media is a dict, extract all media items
                        all_media = []
                        for media_type in ['images', 'videos', 'audios']:
                            if media_type in result.media and isinstance(result.media[media_type], list):
                                for item in result.media[media_type]:
                                    if isinstance(item, dict):
                                        all_media.append({
                                            'type': media_type[:-1],  # Remove 's' from end
                                            'url': item.get('src', item.get('url', '')),
                                            'alt': item.get('alt', ''),
                                            'title': item.get('title', '')
                                        })
                        media_list = all_media if all_media else None
                    elif isinstance(result.media, list):
                        media_list = result.media
                
                return CrawlResponse(
                    success=True,
                    url=str(url),  # Convert HttpUrl to string
                    markdown=result.markdown,
                    html=result.html,
                    links=links_list,
                    media=media_list,
                    metadata={
                        "title": getattr(result, 'title', None),
                        "description": getattr(result, 'description', None),
                        "word_count": getattr(result, 'word_count', None),
                        "crawl_timestamp": getattr(result, 'crawl_timestamp', None),
                        "pages_crawled": getattr(result, 'pages_crawled', 1),
                    },
                    pages_crawled=getattr(result, 'pages_crawled', 1)
                )
            else:
                logger.error(f"Failed to deep crawl: {url}")
                return CrawlResponse(
                    success=False,
                    url=str(url),  # Convert HttpUrl to string
                    error="Deep crawl failed - no content extracted",
                    pages_crawled=0
                )
                
    except Exception as e:
        logger.error(f"Error deep crawling {url}: {str(e)}")
        return CrawlResponse(
            success=False,
            url=str(url),  # Convert HttpUrl to string
            error=f"Deep crawl error: {str(e)}",
            pages_crawled=0
        )

@app.post("/crawl", response_model=CrawlResponse)
async def crawl_website(request: CrawlRequest):
    """
    Crawl a website and extract markdown content.
    
    Args:
        request: Contains URL and crawling parameters
        
    Returns:
        CrawlResponse: Contains extracted markdown and metadata
    """
    if AsyncWebCrawler is None:
        raise HTTPException(status_code=503, detail="Crawl4AI not available")
    
    # Validate URL
    if not validate_url(str(request.url)):
        raise HTTPException(status_code=400, detail="Invalid URL format")
    
    try:
        if request.deep_crawl and request.max_pages > 1:
            return await crawl_multiple_pages(request.url, request)
        else:
            return await crawl_single_page(request.url, request)
            
    except Exception as e:
        logger.error(f"Unexpected error in crawl endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

@app.post("/crawl/simple", response_model=CrawlResponse)
async def crawl_simple(url: HttpUrl, extract_query: Optional[str] = None):
    """
    Simple crawl endpoint for quick markdown extraction.
    
    Args:
        url: URL to crawl
        extract_query: Optional LLM extraction query
        
    Returns:
        CrawlResponse: Contains extracted markdown
    """
    if AsyncWebCrawler is None:
        raise HTTPException(status_code=503, detail="Crawl4AI not available")
    
    # Validate URL
    if not validate_url(str(url)):
        raise HTTPException(status_code=400, detail="Invalid URL format")
    
    try:
        logger.info(f"Simple crawl for URL: {url}")
        
        crawl_params = {
            "url": str(url),
            "extract_links": True,
            "word_count_threshold": 10,
        }
        
        # Add LLM extraction if query provided
        if extract_query:
            crawl_params["extraction_strategy"] = LLMExtractionStrategy(
                provider="ollama/llama2",
                api_token="your-api-token",
                instruction=extract_query
            )
        
        async with AsyncWebCrawler() as crawler:
            result = await crawler.arun(**crawl_params)
            
            if result.success:
                # Extract links properly
                links_list = None
                if hasattr(result, 'links') and result.links:
                    if isinstance(result.links, dict):
                        # If links is a dict, extract all links from internal/external
                        all_links = []
                        if 'internal' in result.links:
                            all_links.extend([link.get('href', '') for link in result.links['internal'] if isinstance(link, dict)])
                        if 'external' in result.links:
                            all_links.extend([link.get('href', '') for link in result.links['external'] if isinstance(link, dict)])
                        links_list = all_links if all_links else None
                    elif isinstance(result.links, list):
                        links_list = result.links
                
                return CrawlResponse(
                    success=True,
                    url=str(url),
                    markdown=result.markdown,
                    html=result.html,
                    links=links_list,
                    metadata={
                        "title": getattr(result, 'title', None),
                        "description": getattr(result, 'description', None),
                        "word_count": getattr(result, 'word_count', None),
                    },
                    pages_crawled=1
                )
            else:
                return CrawlResponse(
                    success=False,
                    url=str(url),
                    error="Simple crawl failed - no content extracted",
                    pages_crawled=0
                )
                
    except Exception as e:
        logger.error(f"Error in simple crawl: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Simple crawl failed: {str(e)}")

@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint"""
    return HealthResponse(
        status="healthy",
        crawl4ai_available=AsyncWebCrawler is not None,
        service="crawl4ai"
    )

@app.get("/")
async def root():
    """Root endpoint with service information"""
    return {
        "service": "Crawl4AI Service",
        "version": "1.0.0",
        "endpoints": {
            "crawl": "/crawl",
            "crawl_simple": "/crawl/simple",
            "health": "/health"
        },
        "features": [
            "Single page crawling",
            "Deep crawling with BFS/DFS strategies",
            "LLM-based content extraction",
            "Link and media extraction",
            "Custom headers and user agents",
            "Markdown and HTML output"
        ]
    }

@app.on_event("startup")
async def startup_event():
    """Initialize service on startup"""
    logger.info("Starting Crawl4AI service...")
    
    if AsyncWebCrawler is None:
        logger.error("Crawl4AI not available - service may not function properly")
    else:
        logger.info("Crawl4AI service started successfully")
        
        # Test crawl4ai setup
        try:
            # This will help identify any setup issues
            logger.info("Testing Crawl4AI setup...")
            # We could add a simple test here if needed
        except Exception as e:
            logger.warning(f"Crawl4AI setup test failed: {e}")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=9003)
