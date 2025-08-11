#!/usr/bin/env python3
"""
Debug script to check what's available in boson_multimodal package
"""

import sys
import traceback

def debug_boson_imports():
    """Debug what's available in boson_multimodal"""
    print("=== Debugging boson_multimodal imports ===")
    
    try:
        print("1. Importing boson_multimodal...")
        import boson_multimodal
        print(f"   ✓ boson_multimodal imported successfully")
        print(f"   Version: {getattr(boson_multimodal, '__version__', 'unknown')}")
        
        print("\n2. Checking boson_multimodal attributes...")
        attrs = [attr for attr in dir(boson_multimodal) if not attr.startswith('_')]
        print(f"   Available attributes: {attrs}")
        
        print("\n3. Checking boson_multimodal.__init__.py...")
        try:
            with open(boson_multimodal.__file__, 'r') as f:
                init_content = f.read()
                print(f"   __init__.py content (first 500 chars):")
                print(f"   {init_content[:500]}...")
        except Exception as e:
            print(f"   Could not read __init__.py: {e}")
        
        print("\n4. Testing specific imports...")
        
        # Test HiggsAudioModel import
        try:
            from boson_multimodal.model.higgs_audio.modeling_higgs_audio import HiggsAudioModel
            print("   ✓ HiggsAudioModel imported successfully")
        except ImportError as e:
            print(f"   ✗ HiggsAudioModel import failed: {e}")
        
        # Test BosonMultimodalForCausalLM import
        try:
            from boson_multimodal import BosonMultimodalForCausalLM
            print("   ✓ BosonMultimodalForCausalLM imported successfully")
        except ImportError as e:
            print(f"   ✗ BosonMultimodalForCausalLM import failed: {e}")
        
        # Test direct HiggsAudioModel import
        try:
            from boson_multimodal import HiggsAudioModel
            print("   ✓ HiggsAudioModel imported directly from boson_multimodal")
        except ImportError as e:
            print(f"   ✗ Direct HiggsAudioModel import failed: {e}")
        
        print("\n5. Checking model directories...")
        try:
            import os
            model_dir = os.path.join(os.path.dirname(boson_multimodal.__file__), 'model')
            if os.path.exists(model_dir):
                print(f"   Model directory exists: {model_dir}")
                subdirs = [d for d in os.listdir(model_dir) if os.path.isdir(os.path.join(model_dir, d))]
                print(f"   Model subdirectories: {subdirs}")
                
                # Check for higgs_audio directory
                higgs_dir = os.path.join(model_dir, 'higgs_audio')
                if os.path.exists(higgs_dir):
                    print(f"   Higgs audio directory exists: {higgs_dir}")
                    higgs_files = os.listdir(higgs_dir)
                    print(f"   Higgs audio files: {higgs_files}")
                else:
                    print(f"   Higgs audio directory not found")
            else:
                print(f"   Model directory not found: {model_dir}")
        except Exception as e:
            print(f"   Error checking model directories: {e}")
        
        return True
        
    except ImportError as e:
        print(f"✗ Failed to import boson_multimodal: {e}")
        print(f"Stack trace: {traceback.format_exc()}")
        return False
    except Exception as e:
        print(f"✗ Unexpected error: {e}")
        print(f"Stack trace: {traceback.format_exc()}")
        return False

def main():
    """Main debug function"""
    print("🔍 Boson Multimodal Import Debug")
    print("=" * 50)
    
    success = debug_boson_imports()
    
    if success:
        print("\n" + "=" * 50)
        print("✅ Debug completed successfully")
        print("Check the output above to understand the package structure")
    else:
        print("\n" + "=" * 50)
        print("❌ Debug failed")
        print("boson_multimodal package may not be installed correctly")
    
    print("\n" + "=" * 50)

if __name__ == "__main__":
    main()
