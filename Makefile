check-bun:
	@which bun > /dev/null 2>&1 || (echo "Bun not found, installing..." && curl -fsSL https://bun.sh/install | bash)

install: check-bun
	@echo "Installing dependencies..."
	bun install
	@echo ""
	@echo "Installing web dependencies..."
	cd web && bun install

dev:
	bun dev

up:
	@bash scripts/up.sh

down:
	@bash scripts/down.sh

restart:
	@bash scripts/down.sh
	@bash scripts/up.sh

install-autostart:
	@bash scripts/install-autostart.sh
