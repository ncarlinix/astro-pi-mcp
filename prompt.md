# Project: AstroPilot AI

## An AI Copilot for PixInsight and Astrophotography

# Vision

Build the world's most advanced open-source AI assistant for astrophotography.

This project should not simply automate PixInsight.

It should understand astrophotography, understand astronomical images, reason like an experienced PixInsight user, and execute complete processing workflows automatically.

PixInsight is the first supported backend, but the architecture should allow future integrations with applications such as Siril, GraXpert, DeepSkyStacker, NINA, Voyager, ASIAIR exports, and AstroPixelProcessor.

The system must work on:

* macOS (Intel + Apple Silicon)
* Windows
* Future Linux support where possible

The project must use:

* TypeScript
* Node.js
* MCP SDK
* PixInsight JavaScript Runtime (PJSR)
* Claude Desktop / Claude Code
* Vision models
* JSON communication
* Plugin architecture

Avoid native C++ modules and PixInsight module signing.

---

# Core Philosophy

The user should never have to think in terms of PixInsight processes.

Instead of:

"Run BlurX."

The user should say:

"Process this image."

or

"Make this galaxy look natural."

or

"Create a dramatic Hubble-style palette."

or

"Reduce stars but preserve tiny galaxies."

The AI determines every processing step.

---

# Long-Term Goals

The assistant should be able to:

• Open astronomical images

• Understand what they contain

• Determine whether they are:

* Linear
* Stretched
* OSC
* Mono
* LRGB
* SHO
* HOO
* Narrowband
* Broadband

• Read metadata from:

* XISF
* FITS
* TIFF

• Detect:

* Camera
* Telescope
* Filter
* Gain
* Offset
* Exposure
* Pixel size
* Focal length
* Image scale
* Target

• Plate solve automatically

• Query astronomical databases

• Build an optimized processing workflow

• Execute it

• Evaluate intermediate results

• Improve parameters automatically

• Explain every decision

---

# Architecture

Claude

↓

AstroPilot MCP Server

↓

Processing Engine

↓

PixInsight PJSR

↓

PixInsight

No native modules.

No C++.

No module signing.

Communication should occur using JSON command queues or another robust, cross-platform mechanism.

---

# Development Roadmap

# Stage 1 — Foundation

Create the project skeleton.

Technology:

* TypeScript
* Node
* MCP SDK
* Vitest
* ESLint
* Prettier
* Zod
* Pino

Features

Configuration

Logging

Cross-platform support

Plugin system

Automatic PixInsight detection

Unit tests

---

# Stage 2 — PixInsight Integration

Create a persistent JavaScript process inside PixInsight that listens for commands.

Support:

Execute JavaScript

Run Process Icons

Run PixInsight processes

Return results

Return errors

Monitor progress

Recover after failures

---

# Stage 3 — MCP Tools

Expose tools such as:

open_image()

save_image()

close_image()

list_images()

active_image()

run_process()

execute_js()

run_process_icon()

wait_until_idle()

cancel_job()

image_statistics()

plate_solve()

take_screenshot()

export_preview()

---

# Stage 4 — Image Understanding

The assistant must inspect images automatically.

Determine:

Linear vs nonlinear

Signal-to-noise ratio

Histogram

Dynamic range

Noise estimate

FWHM

Eccentricity

Gradient severity

Star density

Background neutrality

Color balance

Clipping

Saturation

Image scale

---

# Stage 5 — Astrophotography Knowledge Engine

The AI should classify the target.

Examples:

Emission Nebula

Reflection Nebula

Planetary Nebula

Galaxy

Globular Cluster

Open Cluster

Dark Nebula

Comet

Moon

Sun

Planet

Milky Way

Widefield

Starfield

Use:

Plate solving

Metadata

Vision

SIMBAD

NED

Astrometry

---

# Stage 6 — Workflow Intelligence

Instead of exposing PixInsight processes, expose astrophotography workflows.

Examples

process_galaxy()

process_emission_nebula()

process_reflection_nebula()

process_planetary()

process_cluster()

process_comet()

process_lunar()

process_solar()

Each workflow chooses the appropriate PixInsight processes automatically.

---

# Stage 7 — AI Decision Making

The AI should determine:

Whether DBE is necessary

Whether ABE is sufficient

Whether BlurX is needed

Recommended BlurX strength

NoiseX strength

SPCC vs PCC

Whether to remove stars

Whether to stretch before or after star removal

Recommended deconvolution

Color calibration strategy

Sharpening strategy

Star reduction amount

Noise reduction amount

Contrast enhancement

HDR processing

---

# Stage 8 — Vision Feedback Loop

This is one of the defining features.

Workflow:

Execute process

↓

Take screenshot

↓

Analyze result

↓

Determine whether improvement is needed

↓

Adjust parameters

↓

Repeat

The assistant should iterate until the image meets quality goals or reaches a configurable iteration limit.

---

# Stage 9 — Advanced Processing

Support:

Star extraction

Nebula extraction

Separate processing

Star recombination

Halo correction

Local contrast enhancement

Mask generation

Automatic masks

Luminance masks

Range masks

Star masks

Object masks

AI-generated masks

---

# Stage 10 — Palette Engine

Support palette generation.

Natural

HOO

SHO (true, when data exists)

Synthetic SHO (clearly labeled)

Foraxx

Gold

Blue-Gold

Hubble-inspired

Custom palettes

Allow users to describe palettes naturally.

Example:

"Give this image warm golden hydrogen with deep blue oxygen."

---

# Stage 11 — OSC Intelligence

Understand OSC cameras.

Examples:

ASI533MC Pro

ASI2600MC

ASI294MC

Canon DSLR

Sony mirrorless

Automatically determine appropriate workflows.

For dual-band filters:

Extract synthetic Ha

Extract synthetic OIII

Produce HOO

Offer synthetic SHO as an artistic interpretation

Never claim synthetic SII is scientifically accurate.

---

# Stage 12 — Equipment Profiles

Maintain reusable equipment profiles.

Example:

Camera

Scope

Reducer

Mount

Filter

Bortle class

Typical exposure

Gain

Preferred processing style

The AI should adapt recommendations automatically.

---

# Stage 13 — Learning Mode

The assistant should explain itself.

Examples:

Why was BlurX applied?

Why use SPCC instead of PCC?

Why remove stars?

What does DBE accomplish?

Teach PixInsight concepts while processing.

---

# Stage 14 — Processing Recipes

Support reusable recipes.

Examples:

Natural Galaxy

High Contrast Galaxy

OSC Nebula

Dual-band Nebula

Broadband Reflection Nebula

Planetary Nebula

Beginner Friendly

Scientific

Artistic

Users can save, modify, share, and version recipes.

---

# Stage 15 — Image Evaluation

The AI should critique images.

Report:

Noise

Stars

Gradient

Halos

Color balance

Dynamic range

Saturation

Artifacts

Walking noise

Banding

Residual gradients

Clipping

Overall score

Also explain how to improve each issue.

---

# Stage 16 — Multi-Version Processing

Generate multiple interpretations automatically.

Examples:

Natural

APOD-style

SHO

HOO

Foraxx

Blue-Gold

High Contrast

Soft

Print Ready

Social Media

Allow side-by-side comparison.

---

# Stage 17 — Project Management

Manage an entire astrophotography project.

Lights

Darks

Flats

Bias

Calibration

Integration

Processing history

Snapshots

Version comparison

Export complete processing reports.

---

# Stage 18 — AI Memory

Remember user preferences.

Examples:

Preferred stretching style

Favorite palette

Noise tolerance

Star size preference

Galaxy processing style

Nebula processing style

Teaching level

Allow project-specific overrides.

---

# Stage 19 — Plugin Architecture

Allow third-party plugins.

Future integrations:

Siril

GraXpert

RC-Astro tools

NINA

Voyager

AstroPixelProcessor

Remote observatories

---

# Stage 20 — Future AI

Eventually support:

Image planning

Capture recommendations

Target recommendations

Weather awareness

Moon avoidance

Framing assistance

Exposure optimization

Filter recommendations

Mosaic planning

Automatic processing after acquisition

---

# Guiding Principles

The AI should:

Think before processing.

Analyze before acting.

Explain every important decision.

Iterate until the image improves.

Preserve scientific integrity when requested.

Support artistic creativity when requested.

Never fabricate scientific data.

Clearly distinguish scientific processing from artistic interpretation.

---

# Success Criteria

A user should be able to say:

"Open my calibrated master of the Rosette Nebula taken with an ASI533MC Pro and an L-Ultimate filter. Determine the best workflow, process it as a natural image, then create HOO and synthetic SHO versions, optimize each automatically, explain every major decision, save all outputs, and generate a processing report."

The assistant should complete the entire workflow with minimal user intervention while allowing expert users to inspect, modify, or override every decision.
