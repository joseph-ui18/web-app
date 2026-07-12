const db = require('../models');
const Order = db.Order;
const OrderLine = db.OrderLine;
const Product = db.Product;
const Cart = db.Cart;
const Address = db.Address;
const User = db.User;
const sequelize = db.sequelize;
const { sendOrderReceiptEmail } = require('../utils/orderReceipt');

/* ============================================================
   CHECKOUT — builds an Order from the buyer's current Cart
   ============================================================ */
exports.createOrder = async (req, res) => {
    const buyerId = req.user.id;
    const { address_id, payment_method, cart_item_ids } = req.body;

    if (!address_id) {
        return res.status(400).json({ error: 'address_id is required' });
    }

    // confirm the address belongs to this buyer
    const address = await Address.findOne({ where: { id: address_id, user_id: buyerId } });
    if (!address) {
        return res.status(400).json({ error: 'Invalid delivery address' });
    }

    // build the where clause: if specific cart item IDs were sent, only fetch those rows
    const cartWhere = { user_id: buyerId };
    if (Array.isArray(cart_item_ids) && cart_item_ids.length) {
        cartWhere.id = cart_item_ids;
    }

    const cartItems = await Cart.findAll({ where: cartWhere, include: [{ model: Product }] });
    if (cartItems.length === 0) {
        return res.status(400).json({ error: 'No matching items found in your cart' });
    }

    const transaction = await sequelize.transaction();

    try {
        // validate that products still exist and have enough stock
        for (const item of cartItems) {
            const product = item.Product;

            if (!product) {
                await transaction.rollback();
                return res.status(400).json({
                    error: 'A product in your cart is no longer available'
                });
            }

            if (product.stock_quantity < item.quantity) {
                await transaction.rollback();
                return res.status(400).json({
                    error: `Insufficient stock for ${product.name}. Available: ${product.stock_quantity}`
                });
            }
        }

        const order = await Order.create({
            buyer_id: buyerId,
            address_id,
            payment_method: payment_method || 'Cash on Delivery',
            status: 'pending'
        }, { transaction });

        let total = 0;
        const orderedCartIds = [];

        for (const item of cartItems) {
            const product = item.Product;

            await OrderLine.create({
                order_id: order.id,
                product_id: product.id,
                quantity: item.quantity,
                price_at_purchase: product.sell_price
            }, { transaction });

            await product.update(
                { stock_quantity: product.stock_quantity - item.quantity },
                { transaction }
            );

            total += parseFloat(product.sell_price) * item.quantity;
            orderedCartIds.push(item.id);
        }

        // only remove the cart rows that were actually ordered — leave the rest untouched
        await Cart.destroy({ where: { id: orderedCartIds, user_id: buyerId }, transaction });

        await transaction.commit();

        const buyer = await User.findByPk(buyerId, { attributes: ['id', 'name', 'email'] });
        const populatedOrder = await Order.findByPk(order.id, {
            include: [{ model: OrderLine, include: [{ model: Product }] }, { model: Address }]
        });
        await sendOrderReceiptEmail(populatedOrder, buyer, address, populatedOrder.OrderLines, 'placed');

        return res.status(201).json({
            success: true,
            message: 'Order placed successfully',
            order_id: order.id,
            total_price: total
        });
    } catch (error) {
        await transaction.rollback();
        console.error(error);
        return res.status(500).json({ error: 'Error processing checkout', details: error.message });
    }
};

/* ============================================================
   MY ORDER HISTORY (buyer)
   ============================================================ */
exports.getMyOrders = async (req, res) => {
    try {
        const buyerId = req.user.id;

        const orders = await Order.findAll({
            where: { buyer_id: buyerId },
            include: [
                { model: OrderLine, include: [{ model: Product }] },
                { model: Address }
            ],
            order: [['created_at', 'DESC']]
        });

        return res.status(200).json({ success: true, rows: orders });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Error fetching orders' });
    }
};

/* ============================================================
   SINGLE ORDER (buyer can only view their own)
   ============================================================ */
exports.getMyOrderById = async (req, res) => {
    try {
        const buyerId = req.user.id;
        const { id } = req.params;

        const order = await Order.findOne({
            where: { id, buyer_id: buyerId },
            include: [
                { model: OrderLine, include: [{ model: Product }] },
                { model: Address }
            ]
        });

        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }

        return res.status(200).json({ success: true, result: order });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Error fetching order' });
    }
};

/* ============================================================
   ADMIN: ALL ORDERS
   ============================================================ */
exports.adminGetAllOrders = async (req, res) => {
    try {
        const { status } = req.query;
        const whereClause = status ? { status } : {};

        const orders = await Order.findAll({
            where: whereClause,
            include: [
                { model: OrderLine, include: [{ model: Product }] },
                { model: Address },
                { model: User, as: 'Buyer', attributes: ['id', 'name', 'email'] }
            ],
            order: [['created_at', 'DESC']]
        });

        return res.status(200).json({ success: true, rows: orders });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Error fetching all orders' });
    }
};

/* ============================================================
   ADMIN: UPDATE ORDER STATUS
   ============================================================ */
exports.updateOrderStatus = async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!['pending', 'shipped', 'completed', 'cancelled'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status value' });
    }

    const order = await Order.findByPk(id, { include: [{ model: OrderLine }] });
    if (!order) {
        return res.status(404).json({ error: 'Order not found' });
    }

    // block cancelling once shipped or already completed
    if (status === 'cancelled' && order.status !== 'pending') {
        return res.status(400).json({ error: `Cannot cancel order. Current status: ${order.status}` });
    }

    // block moving a shipped order back to pending
    if (order.status === 'shipped' && status === 'pending') {
        return res.status(400).json({ error: 'Cannot move a shipped order back to pending' });
    }

    // block moving a completed order back to any earlier status
    if (order.status === 'completed' && status !== 'completed') {
        return res.status(400).json({ error: 'Cannot change the status of a completed order' });
    }

    const buyer = await User.findByPk(order.buyer_id, { attributes: ['id', 'name', 'email'] });
    const address = await Address.findByPk(order.address_id);

    if (status === 'cancelled' && order.status === 'pending') {
        const transaction = await sequelize.transaction();
        try {
            for (const line of order.OrderLines) {
                const product = await Product.findByPk(line.product_id, { transaction });
                if (product) {
                    await product.update(
                        { stock_quantity: product.stock_quantity + line.quantity },
                        { transaction }
                    );
                }
            }
            await order.update({ status }, { transaction });
            await transaction.commit();
        } catch (error) {
            await transaction.rollback();
            console.error(error);
            return res.status(500).json({ error: 'Error cancelling order' });
        }
    } else {
        await order.update({ status });
    }

    const updatedOrder = await Order.findByPk(id, {
        include: [{ model: OrderLine, include: [{ model: Product }] }, { model: Address }]
    });

    if (updatedOrder && buyer?.email) {
        await sendOrderReceiptEmail(updatedOrder, buyer, address, updatedOrder.OrderLines, status);
    }

    return res.status(200).json({ success: true, message: `Order status updated to ${status}`, order: updatedOrder });
};

/* ============================================================
   BUYER: CANCEL THEIR OWN ORDER (only while still pending)
   ============================================================ */
exports.cancelOrder = async (req, res) => {
    const buyerId = req.user.id;
    const { id } = req.params;

    const order = await Order.findOne({
        where: { id, buyer_id: buyerId },
        include: [{ model: OrderLine }]
    });

    if (!order) {
        return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'pending') {
        return res.status(400).json({ error: `Cannot cancel order. Current status: ${order.status}` });
    }

    const transaction = await sequelize.transaction();

    try {
        for (const line of order.OrderLines) {
            const product = await Product.findByPk(line.product_id, { transaction });
            if (product) {
                await product.update(
                    { stock_quantity: product.stock_quantity + line.quantity },
                    { transaction }
                );
            }
        }

        await order.update({ status: 'cancelled' }, { transaction });
        await transaction.commit();

        const buyer = await User.findByPk(buyerId, { attributes: ['id', 'name', 'email'] });
        const address = await Address.findByPk(order.address_id);
        const updatedOrder = await Order.findByPk(id, {
            include: [{ model: OrderLine, include: [{ model: Product }] }, { model: Address }]
        });

        if (updatedOrder && buyer?.email) {
            await sendOrderReceiptEmail(updatedOrder, buyer, address, updatedOrder.OrderLines, 'cancelled');
        }

        return res.status(200).json({ success: true, message: 'Order cancelled and stock restored' });
    } catch (error) {
        await transaction.rollback();
        console.error(error);
        return res.status(500).json({ error: 'Error cancelling order', details: error.message });
    }
};