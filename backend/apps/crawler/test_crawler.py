#!/usr/bin/env python3
"""
Test script for the Crawl4AI service
"""

import asyncio
import json
import requests
import time
from typing import Dict, Any

def test_health_endpoint(base_url: str = "http://localhost:9003") -> bool:
    """Test the health endpoint"""
    try:
        response = requests.get(f"{base_url}/health", timeout=10)
        if response.status_code == 200:
            data = response.json()
            print(f"✅ Health check passed: {data}")
            return True
        else:
            print(f"❌ Health check failed: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ Health check error: {e}")
        return False

def test_root_endpoint(base_url: str = "http://localhost:9003") -> bool:
    """Test the root endpoint"""
    try:
        response = requests.get(f"{base_url}/", timeout=10)
        if response.status_code == 200:
            data = response.json()
            print(f"✅ Root endpoint passed: {data['service']}")
            return True
        else:
            print(f"❌ Root endpoint failed: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ Root endpoint error: {e}")
        return False

def test_simple_crawl(base_url: str = "http://localhost:9003") -> bool:
    """Test the simple crawl endpoint"""
    try:
        # Test with a simple, reliable website
        test_url = "https://httpbin.org/html"
        
        response = requests.post(
            f"{base_url}/crawl/simple",
            params={"url": test_url},
            timeout=30
        )
        
        if response.status_code == 200:
            data = response.json()
            if data.get("success") and data.get("markdown"):
                print(f"✅ Simple crawl passed: {len(data['markdown'])} characters extracted")
                return True
            else:
                print(f"❌ Simple crawl failed: {data.get('error', 'Unknown error')}")
                return False
        else:
            print(f"❌ Simple crawl failed: {response.status_code} - {response.text}")
            return False
    except Exception as e:
        print(f"❌ Simple crawl error: {e}")
        return False

def test_advanced_crawl(base_url: str = "http://localhost:9003") -> bool:
    """Test the advanced crawl endpoint"""
    try:
        # Test with a more complex request
        test_data = {
            "url": "https://httpbin.org/html",
            "max_pages": 1,
            "deep_crawl": False,
            "extract_links": True,
            "extract_media": False,
            "word_count_threshold": 5,
            "delay_between_requests": 1.0
        }
        
        response = requests.post(
            f"{base_url}/crawl",
            json=test_data,
            timeout=30
        )
        
        if response.status_code == 200:
            data = response.json()
            if data.get("success") and data.get("markdown"):
                print(f"✅ Advanced crawl passed: {len(data['markdown'])} characters extracted")
                if data.get("links"):
                    print(f"   Found {len(data['links'])} links")
                return True
            else:
                print(f"❌ Advanced crawl failed: {data.get('error', 'Unknown error')}")
                return False
        else:
            print(f"❌ Advanced crawl failed: {response.status_code} - {response.text}")
            return False
    except Exception as e:
        print(f"❌ Advanced crawl error: {e}")
        return False

def main():
    """Run all tests"""
    print("🧪 Testing Crawl4AI Service")
    print("=" * 50)
    
    base_url = "http://localhost:9003"
    
    tests = [
        ("Health Check", test_health_endpoint),
        ("Root Endpoint", test_root_endpoint),
        ("Simple Crawl", test_simple_crawl),
        ("Advanced Crawl", test_advanced_crawl),
    ]
    
    results = []
    for test_name, test_func in tests:
        print(f"\n🔍 Running {test_name}...")
        try:
            result = test_func(base_url)
            results.append((test_name, result))
        except Exception as e:
            print(f"❌ {test_name} crashed: {e}")
            results.append((test_name, False))
    
    print("\n" + "=" * 50)
    print("📊 Test Results:")
    
    passed = 0
    for test_name, result in results:
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"  {test_name}: {status}")
        if result:
            passed += 1
    
    print(f"\n🎯 Summary: {passed}/{len(results)} tests passed")
    
    if passed == len(results):
        print("🎉 All tests passed! The crawler service is working correctly.")
    else:
        print("⚠️  Some tests failed. Check the service logs for details.")

if __name__ == "__main__":
    main()
