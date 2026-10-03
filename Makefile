.PHONY: install frontend build test

install:
	cd frontend && npm install

frontend:
	cd frontend && npm run dev

build:
	cd frontend && npm run build

test:
	cd frontend && npm run test
