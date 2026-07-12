const db = require('../models');
const Order = db.Order;
const OrderLine = db.OrderLine;
const Product = db.Product;
const sequelize = db.sequelize;
const { Op } = require('sequelize');

/* ============================================================
   SALES SUMMARY — total revenue, order counts by status
   Query params: ?from=YYYY-MM-DD&to=YYYY-MM-DD (optional)
   ============================================================ */
exports.getSalesSummary = async (req, res) => {
    try {
        const { from, to } = req.query;
        const dateFilter = {};
        if (from) dateFilter[Op.gte] = new Date(from);
        if (to) dateFilter[Op.lte] = new Date(to);

        const whereClause = { status: 'completed' };
        if (from || to) whereClause.createdAt = dateFilter;  // was created_at

        // total revenue = sum of quantity * price_at_purchase across completed orders
        const completedOrders = await Order.findAll({
            where: whereClause,
            include: [{ model: OrderLine }]
        });

        let totalRevenue = 0;
        let totalItemsSold = 0;
        completedOrders.forEach(order => {
            order.OrderLines.forEach(line => {
                totalRevenue += parseFloat(line.price_at_purchase) * line.quantity;
                totalItemsSold += line.quantity;
            });
        });

        // order counts grouped by status (ignores date filter — shows overall pipeline)
        const statusCounts = await Order.findAll({
            attributes: ['status', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
            group: ['status']
        });

        return res.status(200).json({
            success: true,
            summary: {
                total_revenue: totalRevenue.toFixed(2),
                total_orders_completed: completedOrders.length,
                total_items_sold: totalItemsSold,
                orders_by_status: statusCounts.map(s => ({ status: s.status, count: parseInt(s.get('count')) }))
            }
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Error generating sales summary' });
    }
};

/* ============================================================
   REVENUE OVER TIME (daily) — for line/bar chart
   Query params: ?from=YYYY-MM-DD&to=YYYY-MM-DD (optional)
   ============================================================ */
exports.getRevenueOverTime = async (req, res) => {
    try {
        const { from, to } = req.query;
        const whereClause = { status: 'completed' };
        if (from || to) {
            whereClause.createdAt = {};  // was created_at
            if (from) whereClause.createdAt[Op.gte] = new Date(from);
            if (to) whereClause.createdAt[Op.lte] = new Date(to);
        }

        const orders = await Order.findAll({
            where: whereClause,
            include: [{ model: OrderLine }],
            order: [['createdAt', 'ASC']]  // was created_at
        });

        // group revenue by calendar day
        const revenueByDay = {};
        orders.forEach(order => {
            const day = order.createdAt.toISOString().split('T')[0];  // was created_at — this is the line that was crashing
            const orderTotal = order.OrderLines.reduce(
                (sum, line) => sum + parseFloat(line.price_at_purchase) * line.quantity,
                0
            );
            revenueByDay[day] = (revenueByDay[day] || 0) + orderTotal;
        });

        const chartData = Object.entries(revenueByDay).map(([date, revenue]) => ({
            date,
            revenue: parseFloat(revenue.toFixed(2))
        }));

        return res.status(200).json({ success: true, rows: chartData });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Error generating revenue chart data' });
    }
};

/* ============================================================
   TOP SELLING PRODUCTS — for bar chart / leaderboard
   Query params: ?limit=10 (default 10)
   ============================================================ */
exports.getTopProducts = async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;

        const topLines = await OrderLine.findAll({
            attributes: [
                'product_id',
                [sequelize.fn('SUM', sequelize.col('quantity')), 'total_quantity'],
                [sequelize.fn('SUM', sequelize.literal('quantity * price_at_purchase')), 'total_revenue']
            ],
            include: [{
                model: Order,
                attributes: [],
                where: { status: 'completed' }
            }],
            group: ['OrderLine.product_id'],
            order: [[sequelize.literal('total_quantity'), 'DESC']],
            limit
        });

        // attach product names
        const productIds = topLines.map(l => l.product_id);
        const products = await Product.findAll({ where: { id: productIds }, paranoid: false });
        const productMap = Object.fromEntries(products.map(p => [p.id, p.name]));

        const result = topLines.map(l => ({
            product_id: l.product_id,
            product_name: productMap[l.product_id] || 'Unknown Product',
            total_quantity: parseInt(l.get('total_quantity')),
            total_revenue: parseFloat(l.get('total_revenue')).toFixed(2)
        }));

        return res.status(200).json({ success: true, rows: result });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Error generating top products report' });
    }
};

/* ============================================================
   ORDER COUNTS OVER TIME (daily) — for order-volume chart
   Query params: ?from=YYYY-MM-DD&to=YYYY-MM-DD (optional)
   ============================================================ */
exports.getOrderVolumeOverTime = async (req, res) => {
    try {
        const { from, to } = req.query;
        const whereClause = {};
        if (from || to) {
            whereClause.createdAt = {};  // was created_at
            if (from) whereClause.createdAt[Op.gte] = new Date(from);
            if (to) whereClause.createdAt[Op.lte] = new Date(to);
        }

        const orders = await Order.findAll({
            where: whereClause,
            attributes: ['id', 'createdAt', 'status']  // was created_at
        });

        const countsByDay = {};
        orders.forEach(order => {
            const day = order.createdAt.toISOString().split('T')[0];  // was created_at
            countsByDay[day] = (countsByDay[day] || 0) + 1;
        });

        const chartData = Object.entries(countsByDay).map(([date, count]) => ({ date, count }));

        return res.status(200).json({ success: true, rows: chartData });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Error generating order volume report' });
    }
};