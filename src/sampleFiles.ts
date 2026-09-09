/**
 * Seed buffers. Deliberately spans the file types this editor is aimed at, so
 * language detection and the added tokenizers are visible on first launch.
 */
export const SAMPLE_FILES: Record<string, string> = {
  "main.tf": `terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "environment" {
  type        = string
  description = "Deployment environment"
  default     = "staging"
}

resource "aws_s3_bucket" "artifacts" {
  bucket = "afteredit-artifacts-\${var.environment}"

  tags = {
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}
`,

  "Jenkinsfile": `@Library('platform-shared') _

pipeline {
  agent { docker { image 'golang:1.23' } }

  environment {
    REGISTRY = 'ghcr.io/afteredit'
    // Single quotes do not interpolate in Groovy - the shell expands this.
    TOKEN = credentials('registry-token')
  }

  stages {
    stage('Test') {
      steps {
        sh 'go test ./... -race -count=1'
      }
    }
    stage('Build') {
      when { branch 'main' }
      steps {
        sh "docker build -t \\\${REGISTRY}/app:\\\${GIT_COMMIT} ."
      }
    }
  }

  post {
    failure { echo 'Pipeline failed' }
    always  { junit 'reports/**/*.xml' }
  }
}
`,

  "policy.rego": `package spacelift

import future.keywords.if
import future.keywords.in

# Deny plans that destroy production data stores.
deny contains msg if {
  resource := input.terraform.resource_changes[_]
  "delete" in resource.change.actions
  startswith(resource.address, "aws_rds_cluster.")
  msg := sprintf("refusing to destroy %v", [resource.address])
}

warn contains msg if {
  count(input.terraform.resource_changes) > 50
  msg := "large plan - review carefully"
}

default allow := false

allow if count(deny) == 0
`,

  Makefile: `.PHONY: all build test lint clean

REGISTRY ?= ghcr.io/afteredit
VERSION  := $(shell git describe --tags --always --dirty)
GOFILES  := $(shell find . -name '*.go' -not -path './vendor/*')

all: lint test build

build:
	@echo "building $(VERSION)"
	go build -ldflags "-X main.version=$(VERSION)" -o bin/app ./cmd/app

test:
	go test ./... -race -count=1

lint:
	golangci-lint run

clean:
	rm -rf bin/
`,

  "docker-compose.yml": `services:
  api:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      - DATABASE_URL=postgres://app:app@db:5432/app
    ports:
      - "8080:8080"
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:16-alpine
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 5s
      retries: 5
`,

  "Cargo.toml": `[package]
name = "afteredit"
version = "0.1.0"
edition = "2021"

[dependencies]
tauri = { version = "2", features = [] }
portable-pty = "0.9.0"
base64 = "0.22"

[profile.release]
lto = true
opt-level = 3
`,
};
