# AI-GEN-SDLCDemo
SDLC AI Demo

## Overview
This project demonstrates how AI agents automate the SDLC lifecycle:

Requirement → JIRA → Documentation → Development → PR → Review

## How to Run Demo

1. Start with requirement:
   docs/requirements/REQ-AI-101.txt

2. Trigger Agents:
   - JiraStoryCreatorAgent
   - DocumentationAgent
   - DevAgent
   - GitAgent
   - PRReviewAgent

## Expected Outcome
- JIRA story created
- Documentation generated
- Code committed via feature branch
- PR raised and reviewed

## Story Documentation
- NGA-17: docs/stories/NGA-17.md