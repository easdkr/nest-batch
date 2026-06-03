import { Migration } from '@mikro-orm/migrations';

export class CreateProduct002 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TABLE IF NOT EXISTS "product" (
      "id" varchar(255) PRIMARY KEY,
      "name" varchar(255) NOT NULL,
      "sku" varchar(255) NOT NULL UNIQUE,
      "price" numeric(12,2) NOT NULL,
      "category" varchar(50) NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now()
    );`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "product_sku_index" ON "product" ("sku");`);
  }
  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS "product";`);
  }
}
