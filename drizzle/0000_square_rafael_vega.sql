CREATE TABLE `documents` (
	`collection` text NOT NULL,
	`document_key` text NOT NULL,
	`payload` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`collection`, `document_key`)
);
