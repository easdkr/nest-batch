import { Entity, Property, PrimaryKey, Unique, Index } from '@mikro-orm/core';
import { randomUUID } from 'crypto';

@Entity({ tableName: 'product' })
@Unique({ properties: ['sku'] })
export class ProductEntity {
  @PrimaryKey()
  id!: string;

  @Property()
  name!: string;

  @Index()
  @Property()
  sku!: string;

  @Property({ type: 'numeric', precision: 12, scale: 2 })
  price!: number;

  @Property()
  category!: string;

  @Property()
  createdAt: Date = new Date();
}
