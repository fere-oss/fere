#!/usr/bin/env python3
"""
Test Django Server for Fere Dashboard Testing

Provides Django-style URL patterns for route detection and a live HTTP server.

Run with: python3 manage.py runserver 0.0.0.0:8083 --noreload
"""

import os
import sys

if __name__ == '__main__':
    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'settings')
    try:
        from django.core.management import execute_from_command_line
    except ImportError as exc:
        raise ImportError(
            "Django is not installed. Run: pip install django"
        ) from exc
    execute_from_command_line(sys.argv)
