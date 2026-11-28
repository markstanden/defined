using System;
using System.Xml.Linq;

/// <summary>A customer from the documented XML contract.</summary>
public sealed record Customer(int Id, string Name);

/// <summary>The production render/parse pair the round-trip law exercises.</summary>
public static class CustomerXml
{
    /// <summary>Renders a customer as the documented XML.</summary>
    /// <param name="customer">The customer to render.</param>
    /// <returns>The customer's XML representation.</returns>
    public static string Render(Customer customer)
    {
        ArgumentNullException.ThrowIfNull(customer);
        return new XElement(
            "customer",
            new XElement("id", customer.Id),
            new XElement("name", customer.Name)).ToString();
    }

    /// <summary>Parses the documented XML back into a customer.</summary>
    /// <param name="xml">The XML to parse.</param>
    /// <returns>The customer the XML describes.</returns>
    public static Customer Parse(string xml)
    {
        ArgumentNullException.ThrowIfNull(xml);
        XElement root = XElement.Parse(xml);
        return new Customer(
            (int)root.Element("id")!,
            (string)root.Element("name")!);
    }
}
