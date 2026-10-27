CREATE TABLE outreach_centers (
    center_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id VARCHAR(100) NOT NULL,
    center_name VARCHAR(100) NOT NULL,
    address VARCHAR(255) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (center_id),
    UNIQUE KEY uq_centers_tenant_id (tenant_id, center_id),
    UNIQUE KEY uq_centers_tenant_name (tenant_id, center_name)
);

CREATE TABLE devices (
    device_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id VARCHAR(100) NOT NULL,
    asset_tag VARCHAR(50) NOT NULL,
    serial_number VARCHAR(100) NOT NULL,
    device_type ENUM('LAPTOP', 'TABLET', 'HOTSPOT') NOT NULL,
    manufacturer VARCHAR(100) NOT NULL,
    model VARCHAR(100) NOT NULL,
    status ENUM('AVAILABLE', 'CHECKED_OUT', 'MAINTENANCE') NOT NULL,
    center_id INT UNSIGNED NOT NULL,
    PRIMARY KEY (device_id),
    UNIQUE KEY uq_devices_tenant_asset (tenant_id, asset_tag),
    UNIQUE KEY uq_devices_tenant_serial (tenant_id, serial_number),
    KEY idx_devices_tenant_center (tenant_id, center_id),
    CONSTRAINT fk_devices_center
        FOREIGN KEY (tenant_id, center_id)
        REFERENCES outreach_centers (tenant_id, center_id)
);